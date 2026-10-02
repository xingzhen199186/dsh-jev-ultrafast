/**
 * The control model, reached through the door the run already has.
 *
 * A run that can ask a model to fill in a field can ask one to write the checklist: the text
 * door is a general model, already configured, already holding whatever credential the run
 * needs, and already able to take either a preset provider or a route DSH serves. Reusing it
 * means the control layer adds no second client, no second credential and no second refusal —
 * and a profile where that door was never configured simply has no control layer, which is
 * the state this whole feature is off in by default.
 *
 * The source is resolved per call rather than captured once: the credential is read from the
 * harness store on the way out, so a run that rotates one is not answered with a stale copy.
 */
import { askText, type TextHelperSource } from '../decision/text-helper'
import type { ControlModel } from './control-model'

/** A checklist is a short json payload; this is not a place to spend a model's output budget. */
export const CONTROL_MAX_TOKENS = 800

/** Wrap the run's text door so it answers the checklist question instead of a filling one. */
export function controlModelFromTextDoor(source: () => TextHelperSource): ControlModel {
  return {
    async call({ system, user, signal }) {
      const { content } = await askText({ ...source(), signal }, system, user, CONTROL_MAX_TOKENS)
      return content
    },
  }
}
