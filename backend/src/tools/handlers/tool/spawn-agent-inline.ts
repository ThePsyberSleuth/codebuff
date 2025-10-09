import {
  validateSpawnState,
  validateAndGetAgentTemplate,
  validateAgentInput,
  logAgentSpawn,
  executeSubagent,
  createAgentState,
} from './spawn-agent-utils'

import type { CodebuffToolHandlerFunction } from '../handler-function-type'
import type {
  CodebuffToolCall,
  CodebuffToolOutput,
} from '@codebuff/common/tools/list'
import type { AgentTemplate } from '@codebuff/common/types/agent-template'
import type { Message } from '@codebuff/common/types/messages/codebuff-message'
import type { PrintModeEvent } from '@codebuff/common/types/print-mode'
import type { AgentState } from '@codebuff/common/types/session-state'
import type { ProjectFileContext } from '@codebuff/common/util/file'
import type { ParamsExcluding } from '@codebuff/types/common'
import type { Logger } from '@codebuff/types/logger'
import type { WebSocket } from 'ws'

type ToolName = 'spawn_agent_inline'
export const handleSpawnAgentInline = ((
  params: {
    previousToolCallFinished: Promise<void>
    toolCall: CodebuffToolCall<ToolName>
    fileContext: ProjectFileContext
    clientSessionId: string
    userInputId: string
    writeToClient: (chunk: string | PrintModeEvent) => void

    getLatestState: () => { messages: Message[] }
    state: {
      ws?: WebSocket
      fingerprintId?: string
      userId?: string
      agentTemplate?: AgentTemplate
      localAgentTemplates?: Record<string, AgentTemplate>
      messages?: Message[]
      agentState?: AgentState
      system?: string
    }
    logger: Logger
  } & ParamsExcluding<
    typeof executeSubagent,
    | 'userInputId'
    | 'prompt'
    | 'spawnParams'
    | 'agentTemplate'
    | 'parentAgentState'
    | 'agentState'
    | 'localAgentTemplates'
    | 'userId'
    | 'parentSystemPrompt'
    | 'onResponseChunk'
    | 'clearUserPromptMessagesAfterResponse'
    | 'ws'
    | 'fingerprintId'
  >,
): { result: Promise<CodebuffToolOutput<ToolName>>; state: {} } => {
  const {
    previousToolCallFinished,
    toolCall,
    userInputId,
    getLatestState,
    state,
  } = params
  const {
    agent_type: agentTypeStr,
    prompt,
    params: spawnParams,
  } = toolCall.input
  const {
    ws,
    fingerprintId,
    userId,
    agentTemplate: parentAgentTemplate,
    localAgentTemplates,
    agentState: parentAgentState,
    system,
  } = validateSpawnState(state, 'spawn_agent_inline')

  const triggerSpawnAgentInline = async () => {
    const { agentTemplate, agentType } = await validateAndGetAgentTemplate({
      ...params,
      agentTypeStr,
      parentAgentTemplate,
      localAgentTemplates,
    })

    validateAgentInput(agentTemplate, agentType, prompt, spawnParams)

    // Create child agent state that shares message history with parent
    const childAgentState: AgentState = createAgentState(
      agentType,
      agentTemplate,
      parentAgentState,
      getLatestState().messages,
      parentAgentState.agentContext,
    )

    logAgentSpawn({
      ...params,
      agentTemplate,
      agentType,
      agentId: childAgentState.agentId,
      parentId: childAgentState.parentId,
      prompt,
      spawnParams,
      inline: true,
    })

    const result = await executeSubagent({
      ...params,
      ws,
      userInputId: `${userInputId}-inline-${agentType}${childAgentState.agentId}`,
      prompt: prompt || '',
      spawnParams,
      agentTemplate,
      parentAgentState,
      agentState: childAgentState,
      localAgentTemplates,
      userId,
      fingerprintId,
      parentSystemPrompt: system,
      onResponseChunk: (chunk) => {
        // Disabled.
        // Inherits parent's onResponseChunk
        // writeToClient(chunk)
      },
      clearUserPromptMessagesAfterResponse: false,
    })

    // Update parent's message history with child's final state
    // Since we share the same message array reference, this should already be updated
    let finalMessages = result.agentState?.messageHistory || state.messages

    state.messages = finalMessages

    // Update parent agent state to reflect shared message history
    if (parentAgentState && result.agentState) {
      parentAgentState.messageHistory = finalMessages
    }

    return undefined
  }

  return {
    result: (async () => {
      await previousToolCallFinished
      await triggerSpawnAgentInline()
      return []
    })(),
    state: {},
  }
}) satisfies CodebuffToolHandlerFunction<ToolName>
