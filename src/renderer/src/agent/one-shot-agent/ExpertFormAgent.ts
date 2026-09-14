import { OneShotAgent } from './OneShotAgent'
import {
  buildExpertChatSystemPrompt,
  buildExpertChatTurnText,
  parseExpertChatReply,
  type ExpertChatMessage,
  type ExpertFormDraft,
  type KnowledgeOption,
} from './expert-form'

/** Conversation state fed back to the model on every turn. */
export interface ExpertFormInput {
  /** Live form values, so a hand-edited field is visible to the model. */
  draft: ExpertFormDraft
  knowledgeFiles: KnowledgeOption[]
  /** Prior turns, oldest first (assistant replies keep their JSON payloads). */
  history: ExpertChatMessage[]
  /** The user's new message. */
  message: string
  locale?: string
}

export interface ExpertFormOutput {
  /** Assistant prose to display (JSON patch stripped). */
  text: string
  /** Fields to merge into the form; empty when the model proposed nothing. */
  draft: ExpertFormDraft
}

/**
 * Conversational expert-form filler for the capability center's editor pane.
 * One turn per call: the panel owns the visible transcript and re-sends it.
 */
export class ExpertFormAgent extends OneShotAgent<ExpertFormInput, ExpertFormOutput> {
  readonly name = 'ExpertFormAgent'

  protected buildSystemPrompt(input: ExpertFormInput): string {
    return buildExpertChatSystemPrompt(input.locale ?? 'zh')
  }

  protected buildUserMessages(input: ExpertFormInput): { role: string; content: string }[] {
    return [
      ...input.history.map((m) => ({ role: m.role, content: m.content })),
      {
        role: 'user',
        content: buildExpertChatTurnText(input.draft, input.knowledgeFiles, input.message, input.locale ?? 'zh'),
      },
    ]
  }

  protected parseResponse(raw: string, input: ExpertFormInput): ExpertFormOutput {
    return parseExpertChatReply(raw, input.knowledgeFiles)
  }

  /** Empty output = the panel shows its failure hint; nothing is applied. */
  protected getDefaultOutput(): ExpertFormOutput {
    return { text: '', draft: {} }
  }
}
