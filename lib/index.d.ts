/**
 * Continue an agent turn when the model only narrated its next action instead
 * of calling a tool.
 *
 * @module dsh-loop-continue
 */

/** Cordis plugin name used by loader diagnostics. */
export declare const name: 'loop-continue'

/** The services this plugin reads from its Cordis context. */
export declare const inject: ['llm']

/** Resolved plugin policy; every field has a default, so all are optional. */
export interface Config {
  /** Hard cap on steering per turn (no infinite loop). */
  maxContinuations?: number
  /** Newest steps shown to the judge. */
  maxSteps?: number
  /** Cap on the trailing assistant text handed to the judge. */
  maxTailChars?: number
  /** Override provider; null = follow the session route. */
  judgeProvider?: string | null
  /** Override model; null = follow the session route. */
  judgeModel?: string | null
  /** Judge output cap. */
  judgeMaxTokens?: number
  /** Judge sampling temperature. */
  judgeTemperature?: number
  /** Message that resumes a steered turn. */
  steerText?: string
  /** Emit a diagnostic line for every hook evaluation. */
  debug?: boolean
}

/** Reconstructed facts about one step of a turn. */
export interface StepSummary {
  step: number
  tools: string[]
  text: string
}

/** Deterministic facts pulled from one turn's own log entries. */
export interface TurnSummary {
  steps: StepSummary[]
  text: string
  userRequest: string
  truncated: boolean
}

/**
 * Reconstruct what one turn actually did from its own log entries.
 *
 * @param events - full session event log snapshot.
 * @param turn - turn whose steps should be summarized.
 * @param maxSteps - how many trailing steps to include.
 */
export declare function summarizeTurn(events: unknown[], turn: number, maxSteps: number): TurnSummary

/**
 * Decide whether one turn's log looks like an unfinished, silently-abandoned
 * narration, before spending an LLM judge call.
 */
export declare function looksUnfinished(summary: TurnSummary): boolean

/** Render the deterministic step summary as compact plain text. */
export declare function renderSummary(summary: TurnSummary, maxTailChars: number): string

/**
 * Parse a strict boolean verdict; anything not clearly `true` counts as false.
 */
export declare function parseVerdict(text: string): boolean

/** Register the turn-stopping guard on a Cordis context. */
export declare function apply(ctx: unknown, config: Config): void
