/**
 * Assembling one run's parts, in one place.
 *
 * The tool and the inspector page both need exactly this: which door, which model, which
 * credential name, which browser — and a browser started when none is connected. Keeping it
 * here means the inspector cannot start a run the tool would not have started, and a change
 * to where a key comes from cannot be made in one path and forgotten in the other.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { BrowserConnection, EnsuredBrowser, LaunchedBrowser } from './browser/launch'
import { ensureBrowser } from './browser/launch'
import type { Config as ConfigShape } from './config'
import { resolveKey } from './credentials'
import { resolveDecisionRoute } from './decision/providers'
import type { TextHelperSource } from './decision/text-helper'
import { resolveTextRoute } from './decision/text-providers'
import { dshRouteId } from './decision/text-providers'
import { assertDshRoute, captureLlm, dshStream } from './dsh-model'
import type { TaskOptions } from './loop'

/** The live settings one run is assembled from, read once so a save mid-run cannot split it. */
export interface RunSettings {
  browserConnection: BrowserConnection
  browserKind: 'chrome' | 'edge'
  browserPath: string
  cdpUrl: string
  userDataDir: string
  decisionProvider: string
  decisionEndpoint: string
  decisionModel: string
  decisionKeyRef: string
  textProvider: string
  textBaseUrl: string
  textModel: string
  textKeyRef: string
  textReasoning: 'none' | 'auto'
  maxSteps: number
  screenshots: boolean
  excludeDeadEndElements: boolean
}

/** Read every live setting once, so one run cannot straddle two versions of the page. */
export function readSettings(config: ConfigShape): RunSettings {
  return {
    browserConnection: config.browserConnection.get(),
    browserKind: config.browserKind.get(),
    browserPath: config.browserPath.get(),
    cdpUrl: config.cdpUrl.get(),
    userDataDir: config.userDataDir.get(),
    decisionProvider: config.decisionProvider.get(),
    decisionEndpoint: config.decisionEndpoint.get(),
    decisionModel: config.decisionModel.get(),
    decisionKeyRef: config.decisionKeyRef.get(),
    textProvider: config.textProvider.get(),
    textBaseUrl: config.textBaseUrl.get(),
    textModel: config.textModel.get(),
    textKeyRef: config.textKeyRef.get(),
    textReasoning: config.textReasoning.get(),
    maxSteps: config.maxSteps.get(),
    screenshots: config.screenshots.get(),
    excludeDeadEndElements: config.excludeDeadEndElements.get(),
  }
}

/** The five settings one text door is assembled from; a page draft may carry only these. */
export type TextSettings = Pick<
  RunSettings,
  'textProvider' | 'textBaseUrl' | 'textModel' | 'textKeyRef' | 'textReasoning'
>

/**
 * The text door, resolved to an address, a model and a key.
 *
 * Two callers ask the same text model different questions — the loop asks what to type into one
 * field, the human command asks which site to open first, and the settings page's test button asks
 * whether the door works at all — so the door is opened here once. A DSH route is handed to the
 * harness' own model service, which owns address and key; that is why its source carries a `dsh`
 * call and no credentials.
 */
export async function resolveTextSource(
  ctx: Context,
  llm: ReturnType<typeof captureLlm>,
  settings: TextSettings,
): Promise<TextHelperSource> {
  const textRoute = resolveTextRoute({
    provider: settings.textProvider,
    baseUrl: settings.textBaseUrl,
    model: settings.textModel,
    keyRef: settings.textKeyRef,
    reasoning: settings.textReasoning,
  })
  if (textRoute.kind === 'dsh') await assertDshRoute(llm.get(), dshRouteId(textRoute.provider))

  return textRoute.kind === 'dsh'
    ? {
        baseUrl: '',
        apiKey: '',
        model: textRoute.model,
        reasoning: textRoute.reasoning,
        dsh: {
          provider: dshRouteId(textRoute.provider),
          stream: (options) => dshStream(llm.get(), options),
        },
      }
    : {
        baseUrl: textRoute.baseUrl,
        apiKey: await resolveKey(ctx, textRoute.keyRef, `文本模型（${textRoute.label}）`),
        model: textRoute.model,
        reasoning: textRoute.reasoning,
      }
}

/** Everything a run needs except its goal and where it starts. */
export type RunBase = Omit<TaskOptions, 'goal' | 'startUrl'>

/** What one caller may override about a run; everything else comes from the settings. */
export type RunOverrides = Partial<
  Pick<TaskOptions, 'maxSteps' | 'screenshots' | 'record' | 'signal' | 'onEvent' | 'gate'>
>

/**
 * Assemble a run: resolve both doors, resolve their credentials, and make sure a browser
 * is there to drive. `note` is what to say about a browser this call had to start, and is
 * empty when one was already connected.
 */
export async function prepareRun(
  ctx: Context,
  config: ConfigShape,
  llm: ReturnType<typeof captureLlm>,
  overrides: RunOverrides = {},
): Promise<{ base: RunBase; note: string }> {
  const settings = readSettings(config)

  // The chosen door decides address, model and credential name together, so a leftover
  // value from the other door can never be used by mistake.
  const decisionRoute = resolveDecisionRoute({
    provider: settings.decisionProvider,
    endpoint: settings.decisionEndpoint,
    model: settings.decisionModel,
    keyRef: settings.decisionKeyRef,
  })
  const textSource = await resolveTextSource(ctx, llm, settings)

  // The browser this run will drive, resolved before the loop starts. When nothing is
  // connected and nothing was pinned, this is where the plugin starts the browser the
  // settings page names — the same act as its 「启动并连接」 button, reached from a task
  // instead of a press. The endpoint it settled on is handed to the loop, so the run
  // drives exactly the browser that was found or started here. On the 「你正在用的浏览器」
  // route nothing is started at all: an unreachable browser there is reported, not replaced.
  const ensured = await ensureBrowser({
    cdpUrl: settings.cdpUrl || undefined,
    userDataDir: settings.userDataDir || undefined,
    preferredKind: settings.browserKind,
    exeOverride: settings.browserPath || undefined,
    connection: settings.browserConnection,
  })

  return {
    note: browserNote(settings.browserConnection, ensured),
    base: {
      maxSteps: overrides.maxSteps ?? settings.maxSteps,
      screenshots: overrides.screenshots ?? settings.screenshots,
      excludeDeadEndElements: settings.excludeDeadEndElements,
      record: overrides.record ?? false,
      signal: overrides.signal,
      onEvent: overrides.onEvent,
      gate: overrides.gate,
      browser: {
        // A socket URL is what a pinned `ws://` setting yields, and the loop's discovery
        // accepts either shape; taking both keeps that door from being lost here.
        cdpUrl: ensured.endpoint.httpUrl || ensured.endpoint.wsUrl,
        userDataDir: settings.userDataDir || undefined,
        preferredKind: settings.browserKind,
        connection: settings.browserConnection,
      },
      decision: {
        endpoint: decisionRoute.endpoint,
        model: decisionRoute.model,
        apiKey: await resolveKey(ctx, decisionRoute.keyRef, `决策服务（${decisionRoute.label}）`),
        wrapFallback: decisionRoute.wrapFallback,
        // Which cell that key came from, so a refusal of it can name the cell and the shape the
        // door expects there instead of leaving the reader with a status code.
        keyOrigin: { ref: decisionRoute.keyRef, label: decisionRoute.label, shape: decisionRoute.keyShape },
      },
      text: textSource,
    },
  }
}

/**
 * What to say when a task had to start a browser itself, and nothing when it did not.
 *
 * A window that appeared on the reader's desktop is not something to leave unsaid, and the
 * one thing they have to know about it is that it is not their everyday browser: it carries
 * the plugin's own profile directory, so a site that needs a login needs it once, by hand.
 */
export function launchNote(launched: LaunchedBrowser | null): string {
  if (launched === null) return ''
  return (
    `本来没有可连的浏览器，已按设置启动 ${launched.label} 并连上` +
    `（它用的是插件自己那份数据目录，与你日常那个分开；需要登录的站点第一次要你亲自登录一次）`
  )
}

/**
 * What to say about the browser a run will drive; nothing when there is nothing to say.
 *
 * A window that appeared on the reader's desktop is not something to leave unsaid. Neither is
 * the one thing the daily route can make them wait on: Chrome/Edge 144+ ask permission on every
 * connection, and the run sits on that box until it is answered rather than timing out — so the
 * note says which browser this is, and what to click if a box appears.
 */
export function browserNote(connection: BrowserConnection, ensured: EnsuredBrowser): string {
  if (ensured.launched !== null) return launchNote(ensured.launched)
  if (connection !== 'daily') return ''
  return (
    `这次连的是你正在用的浏览器（${ensured.endpoint.browser}，登录状态直接可用）。` +
    '如果它弹出「允许远程调试？」，在框上点「允许」，插件会一直等着。'
  )
}
