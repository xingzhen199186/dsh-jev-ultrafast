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
 * The source is asked for per call rather than taken once at wrap time, so a caller that
 * resolves it fresh each time gets a fresh credential and a caller that hands over one fixed
 * source (a run, which resolved it while assembling itself) has its provenance in one place.
 */
import { askText, type TextHelperSource } from '../decision/text-helper'
import type { ControlModel } from './control-model'

/** Wrap the run's text door so it answers the checklist question instead of a filling one. */
export function controlModelFromTextDoor(source: () => TextHelperSource): ControlModel {
  return {
    async call({ system, user, signal }) {
      // No ceiling of our own. A model that reasons spends the same allowance on thinking as on
      // prose — the first real run came back empty for that reason, and the second one said so in
      // as many words — so the checklist question is asked exactly as the rest of the plugin asks
      // it, under the text door's own default and its re-ask for a vendor that refuses a number
      // above its maximum. Trying to be frugal here bought two runs that could not speak at all.
      const { content } = await askText({ ...source(), signal }, system, user)
      return content
    },
  }
}
