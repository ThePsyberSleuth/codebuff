import { trackEvent } from '@codebuff/common/analytics'
import type { NextRequest } from 'next/server'

import { agentRunsPost } from '@/api/v1/agent-runs'
import { getUserInfoFromApiKey } from '@/db/user'
import { logger } from '@/util/logger'

export async function POST(req: NextRequest) {
  return agentRunsPost({ req, getUserInfoFromApiKey, logger, trackEvent })
}
