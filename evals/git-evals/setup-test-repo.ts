#!/usr/bin/env bun

import { execFileSync } from 'child_process'
import fs from 'fs'
import path from 'path'

import { generateCompactId } from '@codebuff/common/util/string'

import { TEST_REPOS_DIR } from '../test-setup'

/**
 * Extracts the repository name from a git URL
 * Supports both HTTPS and SSH formats
 * Examples:
 * - https://github.com/user/repo.git -> repo
 * - git@github.com:user/repo.git -> repo
 * - https://github.com/user/repo -> repo
 */
export function extractRepoNameFromUrl(repoUrl: string): string {
  // Remove .git suffix if present
  let cleanUrl = repoUrl.endsWith('.git') ? repoUrl.slice(0, -4) : repoUrl

  // Handle SSH format: git@github.com:user/repo
  if (cleanUrl.includes('@') && cleanUrl.includes(':')) {
    cleanUrl = cleanUrl.split(':')[1]
  }

  // Handle HTTPS format: https://github.com/user/repo
  if (cleanUrl.includes('://')) {
    cleanUrl = cleanUrl.split('://')[1]
  }

  // Remove domain and get the last part (repo name)
  const parts = cleanUrl.split('/')
  return parts[parts.length - 1]
}

/**
 * Executes a git command with retry logic and exponential backoff
 */
async function executeGitCommandWithRetry(
  command: string,
  args: string[],
  options: any,
  maxRetries: number = 3,
  baseDelay: number = 1000,
): Promise<void> {
  let lastError: Error | undefined

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      execFileSync(command, args, options)
      return // Success!
    } catch (error) {
      lastError = error as Error

      if (attempt < maxRetries - 1) {
        const delay = baseDelay * Math.pow(2, attempt)
        console.warn(
          `Git command failed (attempt ${attempt + 1}/${maxRetries}): ${error instanceof Error ? error.message : String(error)}`,
        )
        console.warn(`Retrying in ${delay}ms...`)
        await new Promise((resolve) => setTimeout(resolve, delay))
      }
    }
  }

  throw lastError || new Error('Git command failed after all retries')
}

export async function setupTestRepo(
  repoUrl: string,
  customRepoName: string,
  commitSha: string = 'HEAD',
  addRandomSuffix: boolean = false,
  initCommand?: string,
): Promise<string> {
  const repoName = customRepoName || extractRepoNameFromUrl(repoUrl)
  console.log(`Setting up test repository: ${repoName}...`)

  const repoBaseDir = path.join(TEST_REPOS_DIR, `${repoName}-${commitSha}`)
  const repoDir = addRandomSuffix
    ? `${repoBaseDir}-${generateCompactId()}`
    : repoBaseDir

  // Create test-repos directory if it doesn't exist
  if (!fs.existsSync(TEST_REPOS_DIR)) {
    fs.mkdirSync(TEST_REPOS_DIR, { recursive: true })
  }

  // Remove existing repo if it exists
  if (fs.existsSync(repoDir)) {
    console.log(`Removing existing ${repoName} repo...`)
    fs.rmSync(repoDir, { recursive: true, force: true })
  }

  try {
    // Check if we're in a CI environment (GitHub Actions or Render.com)
    const isGitHubActions = process.env.GITHUB_ACTIONS === 'true'
    const isRenderCron =
      process.env.RENDER === 'true' || process.env.IS_PULL_REQUEST === 'false'

    // Always try authenticated approach first if we have a token, regardless of environment
    const githubToken = process.env.CODEBUFF_GITHUB_TOKEN
    const shouldUseAuth = githubToken && repoUrl.includes('github.com')

    if (shouldUseAuth) {
      // In CI environments or when we have a token, handle authentication for private repos
      const envName = isGitHubActions
        ? 'GitHub Actions'
        : isRenderCron
          ? 'Render.com'
          : 'Local with token'
      console.log(`${envName} detected - setting up authentication...`)

      let cloneUrl = repoUrl

      // Convert SSH URL to HTTPS with token if needed
      if (repoUrl.startsWith('git@github.com:')) {
        cloneUrl = repoUrl.replace('git@github.com:', 'https://github.com/')
      }
      if (cloneUrl.endsWith('.git')) {
        cloneUrl = cloneUrl.slice(0, -4)
      }

      // Validate token format
      if (
        !githubToken.startsWith('ghp_') &&
        !githubToken.startsWith('github_pat_')
      ) {
        console.warn('GitHub token does not appear to be in expected format')
      }

      // Add token authentication to the URL
      cloneUrl = cloneUrl.replace(
        'https://github.com/',
        `https://${githubToken}@github.com/`,
      )
      console.log('Using GitHub token authentication for private repository')
      console.log(`Token prefix: ${githubToken.substring(0, 10)}...`)

      console.log(
        `Cloning from remote: ${cloneUrl.replace(githubToken || '', '***')}`,
      )

      // Set git configuration for the clone operation
      const gitEnv = {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0', // Disable interactive prompts
        GIT_ASKPASS: 'echo', // Provide empty password if prompted
        GIT_HTTP_LOW_SPEED_LIMIT: '1000', // Minimum speed (bytes/sec)
        GIT_HTTP_LOW_SPEED_TIME: '30', // Time window for speed check (seconds)
      }

      await executeGitCommandWithRetry(
        'git',
        ['clone', '--no-checkout', cloneUrl, repoDir],
        {
          timeout: 600_000, // 10 minute timeout for cloning
          stdio: 'inherit',
          env: gitEnv,
        },
      )
      await executeGitCommandWithRetry('git', ['fetch', 'origin', commitSha], {
        cwd: repoDir,
        stdio: 'inherit',
        env: gitEnv,
      })
      await executeGitCommandWithRetry('git', ['checkout', commitSha], {
        cwd: repoDir,
        stdio: 'inherit',
      })
    } else {
      // Local development or public repos
      console.log(`Local environment detected - cloning from: ${repoUrl}`)

      const localGitEnv = {
        ...process.env,
        GIT_HTTP_LOW_SPEED_LIMIT: '1000', // Minimum speed (bytes/sec)
        GIT_HTTP_LOW_SPEED_TIME: '30', // Time window for speed check (seconds)
      }

      await executeGitCommandWithRetry(
        'git',
        ['clone', '--no-checkout', '--quiet', repoUrl, repoDir],
        {
          timeout: 600_000, // 10 minute timeout for cloning
          stdio: 'inherit',
          env: localGitEnv,
        },
      )
      await executeGitCommandWithRetry(
        'git',
        ['fetch', 'origin', '--quiet', commitSha],
        {
          cwd: repoDir,
          stdio: 'inherit',
          env: localGitEnv,
        },
      )
      await executeGitCommandWithRetry(
        'git',
        ['checkout', '--quiet', commitSha],
        {
          cwd: repoDir,
          stdio: 'inherit',
        },
      )
    }

    console.log('Repository cloned successfully!')

    // Verify the setup worked
    if (!fs.existsSync(path.join(repoDir, '.git'))) {
      throw new Error('Git directory was not cloned properly')
    }

    // Verify git operations work in the cloned repo
    console.log('Verifying git operations...')
    const gitStatus = execFileSync('git', ['status', '--porcelain'], {
      cwd: repoDir,
      encoding: 'utf-8',
      timeout: 10_000,
    })

    console.log(
      `Git status check passed. Working directory status: ${gitStatus.trim() || 'clean'}`,
    )

    // Test that we can access commit history
    const commitCount = execFileSync('git', ['rev-list', '--count', 'HEAD'], {
      cwd: repoDir,
      encoding: 'utf-8',
      timeout: 10_000,
    })
      .toString()
      .trim()

    console.log(`Repository has ${commitCount} commits in history`)

    try {
      if (initCommand) {
        console.log(`Executing initialization command: ${initCommand}`)
        const [command, ...args] = initCommand.split(' ')
        execFileSync(command, args, {
          cwd: repoDir,
          stdio: 'inherit',
          timeout: 240_000, // 4 minute timeout for init commands
        })
        console.log('Initialization command completed successfully')
      }
    } catch (error) {
      console.error('Error executing initialization command:', error)
      throw new Error(
        `Initialization command failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    }

    console.log('Repository verification passed')

    return repoDir
  } catch (error) {
    console.error(`Error setting up ${repoName} repository:`, error)

    // If authentication failed, provide more specific guidance
    if (
      error instanceof Error &&
      (error.message.includes('403') ||
        error.message.includes('authentication'))
    ) {
      console.error('\nAuthentication troubleshooting:')
      console.error(
        '1. Verify CODEBUFF_GITHUB_TOKEN environment variable is set',
      )
      console.error(
        '2. Ensure token has appropriate repository access permissions',
      )
      console.error(
        '3. Check if token is a Personal Access Token (PAT) with repo scope',
      )
      console.error(
        '4. For private repos, ensure token owner has access to the repository',
      )

      const token = process.env.CODEBUFF_GITHUB_TOKEN
      if (token) {
        console.error(
          `Token format: ${token.substring(0, 10)}... (length: ${token.length})`,
        )
      } else {
        console.error('CODEBUFF_GITHUB_TOKEN environment variable is not set')
      }
    }

    throw error
  }
}

// CLI handling
if (require.main === module) {
  const args = process.argv.slice(2)
  if (args.length < 3) {
    console.error(
      'Usage: bun run setup-test-repo <repo-url> <repo-name> <commit-sha>',
    )
    process.exit(1)
  }

  const [repoUrl, repoName, commitSha] = args

  setupTestRepo(repoUrl, repoName, commitSha)
    .then((repoDir) => {
      console.log(`Repository cloned successfully at ${repoDir}`)
      process.exit(0)
    })
    .catch((err) => {
      console.error(`Error setting up repository:`, err)
      process.exit(1)
    })
}
