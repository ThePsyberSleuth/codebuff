import type {
  AddAgentStepFn,
  FinishAgentRunFn,
  StartAgentRunFn,
} from './database'
import type { PromptAiSdkStreamFn } from './llm'
import type { Logger } from './logger'

export type AgentRuntimeDeps = {
  logger: Logger

  startAgentRun: StartAgentRunFn
  finishAgentRun: FinishAgentRunFn
  addAgentStep: AddAgentStepFn

  promptAiSdkStream: PromptAiSdkStreamFn
}
