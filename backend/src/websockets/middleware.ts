import {
  calculateUsageAndBalance,
  triggerMonthlyResetAndGrant,
  checkAndTriggerAutoTopup,
  checkAndTriggerOrgAutoTopup,
  calculateOrganizationUsageAndBalance,
  extractOwnerAndRepo,
  findOrganizationForRepository,
} from '@codebuff/billing'
import db from '@codebuff/common/db'
import * as schema from '@codebuff/common/db/schema'
import { pluralize } from '@codebuff/common/util/string'
import { eq } from 'drizzle-orm'

import { getUserInfoFromAuthToken } from './auth'
import { updateRequestContext } from './request-context'
import { sendAction } from './websocket-action'
import { withAppContext } from '../context/app-context'
import { checkAuth } from '../util/check-auth'
import { logger } from '../util/logger'

import type { UserInfo } from './auth'
import type { ClientAction, ServerAction } from '@codebuff/common/actions'
import type { WebSocket } from 'ws'

type MiddlewareCallback = (
  action: ClientAction,
  clientSessionId: string,
  ws: WebSocket,
  userInfo: UserInfo | undefined,
) => Promise<void | ServerAction>

function getServerErrorAction<T extends ClientAction>(
  action: T,
  error: T extends { type: 'prompt' }
    ? Omit<ServerAction<'prompt-error'>, 'type' | 'userInputId'>
    : Omit<ServerAction<'action-error'>, 'type'>,
): ServerAction<'prompt-error'> | ServerAction<'action-error'> {
  return action.type === 'prompt'
    ? {
        type: 'prompt-error',
        userInputId: action.promptId,
        ...error,
      }
    : {
        type: 'action-error',
        ...error,
      }
}

export class WebSocketMiddleware {
  private middlewares: Array<MiddlewareCallback> = []

  use<T extends ClientAction['type']>(
    callback: (
      action: ClientAction<T>,
      clientSessionId: string,
      ws: WebSocket,
      userInfo: UserInfo | undefined,
    ) => Promise<void | ServerAction>,
  ) {
    this.middlewares.push(callback as MiddlewareCallback)
  }

  async execute(
    action: ClientAction,
    clientSessionId: string,
    ws: WebSocket,
    options: { silent?: boolean } = {},
  ): Promise<boolean> {
    const userInfo =
      'authToken' in action && action.authToken
        ? await getUserInfoFromAuthToken(action.authToken)
        : undefined

    for (const middleware of this.middlewares) {
      const actionOrContinue = await middleware(
        action,
        clientSessionId,
        ws,
        userInfo,
      )
      if (actionOrContinue) {
        logger.warn(
          {
            actionType: action.type,
            middlewareResp: actionOrContinue.type,
            clientSessionId,
          },
          'Middleware execution halted.',
        )
        if (!options.silent) {
          sendAction(ws, actionOrContinue)
        }
        return false
      }
    }
    return true
  }

  run<T extends ClientAction['type']>(
    baseAction: (
      action: ClientAction<T>,
      clientSessionId: string,
      ws: WebSocket,
    ) => void,
    options: { silent?: boolean } = {},
  ) {
    return async (
      action: ClientAction<T>,
      clientSessionId: string,
      ws: WebSocket,
    ) => {
      const userInfo =
        'authToken' in action
          ? await getUserInfoFromAuthToken(action.authToken!)
          : undefined

      // Use the new combined context - much cleaner!
      return withAppContext(
        {
          clientSessionId,
          userId: userInfo?.id,
          userEmail: userInfo?.email,
          discordId: userInfo?.discord_id ?? undefined,
        },
        {}, // request context starts empty
        async () => {
          const shouldContinue = await this.execute(
            action,
            clientSessionId,
            ws,
            options,
          )
          if (shouldContinue) {
            baseAction(action, clientSessionId, ws)
          }
        },
      )
    }
  }
}

export const protec = new WebSocketMiddleware()

protec.use(async (action, clientSessionId, ws, userInfo) =>
  checkAuth({
    fingerprintId: 'fingerprintId' in action ? action.fingerprintId : undefined,
    authToken: 'authToken' in action ? action.authToken : undefined,
    clientSessionId,
  }),
)

// Organization repository coverage detection middleware
protec.use(async (action, clientSessionId, ws, userInfo) => {
  const userId = userInfo?.id

  // Only process actions that have repoUrl as a valid string
  if (
    !('repoUrl' in action) ||
    typeof action.repoUrl !== 'string' ||
    !action.repoUrl ||
    !userId
  ) {
    return undefined
  }

  const repoUrl = action.repoUrl

  try {
    // Extract owner and repo from URL
    const ownerRepo = extractOwnerAndRepo(repoUrl)
    if (!ownerRepo) {
      logger.debug(
        { userId, repoUrl },
        'Could not extract owner/repo from repository URL',
      )
      return undefined
    }

    const { owner, repo } = ownerRepo

    // Perform lookup (cache removed)
    const orgLookup = await findOrganizationForRepository({
      userId,
      repositoryUrl: repoUrl,
      logger,
    })

    // If an organization covers this repository, check its balance
    if (orgLookup.found && orgLookup.organizationId) {
      // Check and trigger organization auto top-up if needed
      try {
        await checkAndTriggerOrgAutoTopup({
          organizationId: orgLookup.organizationId,
          userId,
          logger,
        })
      } catch (error) {
        logger.error(
          {
            error:
              error instanceof Error
                ? {
                    name: error.name,
                    message: error.message,
                    stack: error.stack,
                  }
                : error,
            organizationId: orgLookup.organizationId,
            organizationName: orgLookup.organizationName,
            userId,
            repoUrl,
            action: 'failed_org_auto_topup_check',
            errorType:
              error instanceof Error ? error.constructor.name : typeof error,
          },
          'Error during organization auto top-up check in middleware',
        )
        // Continue execution to check remaining balance
      }

      const now = new Date()
      // For balance checking, precise quotaResetDate isn't as critical as for usageThisCycle.
      // Using a far past date ensures all grants are considered for current balance.
      const orgQuotaResetDate = new Date(0)
      const { balance: orgBalance } =
        await calculateOrganizationUsageAndBalance(
          orgLookup.organizationId,
          orgQuotaResetDate,
          now,
        )

      if (orgBalance.totalRemaining <= 0) {
        const orgName = orgLookup.organizationName || 'Your organization'
        const message =
          orgBalance.totalDebt > 0
            ? `The organization '${orgName}' has a balance of negative ${pluralize(Math.abs(orgBalance.totalDebt), 'credit')}. Please contact your organization administrator.`
            : `The organization '${orgName}' does not have enough credits for this action. Please contact your organization administrator.`

        logger.warn(
          {
            userId,
            repoUrl,
            organizationId: orgLookup.organizationId,
            organizationName: orgName,
            orgBalance: orgBalance.netBalance,
          },
          'Organization has insufficient credits, gating request.',
        )
        return getServerErrorAction(action, {
          error: 'Insufficient organization credits',
          message,
          remainingBalance: orgBalance.netBalance, // Send org balance here
        })
      }
    }

    // Update request context with the results
    updateRequestContext({
      currentUserId: userId,
      approvedOrgIdForRepo: orgLookup.found
        ? orgLookup.organizationId
        : undefined,
      processedRepoUrl: repoUrl,
      processedRepoOwner: owner,
      processedRepoName: repo,
      processedRepoId: `${owner}/${repo}`,
      isRepoApprovedForUserInOrg: orgLookup.found,
    })

    // logger.debug(
    //   {
    //     userId,
    //     repoUrl,
    //     owner,
    //     repo,
    //     isApproved: orgLookup.found,
    //     organizationId: orgLookup.organizationId,
    //     organizationName: orgLookup.organizationName,
    //   },
    //   'Organization repository coverage processed'
    // )
  } catch (error) {
    logger.error(
      { userId, repoUrl, error },
      'Error processing organization repository coverage',
    )
  }

  return undefined
})

protec.use(async (action, clientSessionId, ws, userInfo) => {
  const userId = userInfo?.id
  const fingerprintId =
    'fingerprintId' in action ? action.fingerprintId : 'unknown-fingerprint'

  if (!userId || !fingerprintId) {
    logger.warn(
      {
        userId,
        fingerprintId,
        actionType: action.type,
      },
      'Missing user or fingerprint ID',
    )
    return getServerErrorAction(action, {
      error: 'Missing user or fingerprint ID',
      message: 'Please log in to continue.',
    })
  }

  // Get user info for balance calculation
  const user = await db.query.user.findFirst({
    where: eq(schema.user.id, userId),
    columns: {
      next_quota_reset: true,
      stripe_customer_id: true,
    },
  })

  // Check and trigger monthly reset if needed
  await triggerMonthlyResetAndGrant({ userId, logger })

  // Check if we need to trigger auto top-up and get the amount added (if any)
  let autoTopupAdded: number | undefined = undefined
  try {
    autoTopupAdded = await checkAndTriggerAutoTopup({ userId, logger })
  } catch (error) {
    logger.error(
      {
        error:
          error instanceof Error
            ? {
                name: error.name,
                message: error.message,
                stack: error.stack,
              }
            : error,
        userId,
        clientSessionId,
        action: 'failed_user_auto_topup_check',
        errorType:
          error instanceof Error ? error.constructor.name : typeof error,
      },
      'Error during auto top-up check in middleware',
    )
    // Continue execution to check remaining balance
  }

  const { usageThisCycle, balance } = await calculateUsageAndBalance({
    userId,
    quotaResetDate: user?.next_quota_reset ?? new Date(0),
    logger,
  })

  // Check if we have enough remaining credits
  if (balance.totalRemaining <= 0) {
    // If they have debt, show that in the message
    const message =
      balance.totalDebt > 0
        ? `You have a balance of negative ${pluralize(Math.abs(balance.totalDebt), 'credit')}. Please add credits to continue using Codebuff.`
        : `You do not have enough credits for this action. Please add credits or wait for your next cycle to begin.`

    return getServerErrorAction(action, {
      error: 'Insufficient credits',
      message,
      remainingBalance: balance.netBalance,
    })
  }

  // Send initial usage info if we have sufficient credits
  sendAction(ws, {
    type: 'usage-response',
    usage: usageThisCycle,
    remainingBalance: balance.totalRemaining,
    balanceBreakdown: balance.breakdown,
    next_quota_reset: user?.next_quota_reset ?? null,
    autoTopupAdded, // Include the amount added by auto top-up (if any)
  })

  return undefined
})
