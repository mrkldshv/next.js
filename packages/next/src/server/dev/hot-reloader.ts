import { webpack, StringXor } from 'next/dist/compiled/webpack/webpack'
import type { NextConfigComplete } from '../config-shared'
import type { CustomRoutes } from '../../lib/load-custom-routes'
import { getOverlayMiddleware } from 'next/dist/compiled/@next/react-dev-overlay/dist/middleware'
import { IncomingMessage, ServerResponse } from 'http'
import { WebpackHotMiddleware } from './hot-middleware'
import { join, relative, isAbsolute, posix } from 'path'
import { UrlObject } from 'url'
import {
  createEntrypoints,
  createPagesMapping,
  finalizeEntrypoint,
  getClientEntry,
  getEdgeServerEntry,
  getAppEntry,
  runDependingOnPageType,
} from '../../build/entries'
import { watchCompilers } from '../../build/output'
import * as Log from '../../build/output/log'
import getBaseWebpackConfig, {
  loadProjectInfo,
} from '../../build/webpack-config'
import { APP_DIR_ALIAS, WEBPACK_LAYERS } from '../../lib/constants'
import { recursiveDelete } from '../../lib/recursive-delete'
import {
  BLOCKED_PAGES,
  COMPILER_NAMES,
  RSC_MODULE_TYPES,
} from '../../shared/lib/constants'
import { __ApiPreviewProps } from '../api-utils'
import { getPathMatch } from '../../shared/lib/router/utils/path-match'
import { findPageFile } from '../lib/find-page-file'
import {
  BUILDING,
  getEntries,
  EntryTypes,
  getInvalidator,
  onDemandEntryHandler,
} from './on-demand-entry-handler'
import { denormalizePagePath } from '../../shared/lib/page-path/denormalize-page-path'
import { normalizePathSep } from '../../shared/lib/page-path/normalize-path-sep'
import getRouteFromEntrypoint from '../get-route-from-entrypoint'
import { fileExists } from '../../lib/file-exists'
import { difference, isMiddlewareFilename } from '../../build/utils'
import { DecodeError } from '../../shared/lib/utils'
import { Span, trace } from '../../trace'
import { getProperError } from '../../lib/is-error'
import ws from 'next/dist/compiled/ws'
import { promises as fs } from 'fs'
import { getPageStaticInfo } from '../../build/analysis/get-page-static-info'
import { UnwrapPromise } from '../../lib/coalesced-function'
import { getRegistry } from '../../lib/helpers/get-registry'
import { RouteMatch } from '../future/route-matches/route-match'
import type { Telemetry } from '../../telemetry/storage'
import { parseVersionInfo, VersionInfo } from './parse-version-info'

function diff(a: Set<any>, b: Set<any>) {
  return new Set([...a].filter((v) => !b.has(v)))
}

const wsServer = new ws.Server({ noServer: true })

export async function renderScriptError(
  res: ServerResponse,
  error: Error,
  { verbose = true } = {}
): Promise<{ finished: true | undefined }> {
  // Asks CDNs and others to not to cache the errored page
  res.setHeader(
    'Cache-Control',
    'no-cache, no-store, max-age=0, must-revalidate'
  )

  if ((error as any).code === 'ENOENT') {
    return { finished: undefined }
  }

  if (verbose) {
    console.error(error.stack)
  }
  res.statusCode = 500
  res.end('500 - Internal Error')
  return { finished: true }
}

function addCorsSupport(req: IncomingMessage, res: ServerResponse) {
  // Only rewrite CORS handling when URL matches a hot-reloader middleware
  if (!req.url!.startsWith('/__next')) {
    return { preflight: false }
  }

  if (!req.headers.origin) {
    return { preflight: false }
  }

  res.setHeader('Access-Control-Allow-Origin', req.headers.origin)
  res.setHeader('Access-Control-Allow-Methods', 'OPTIONS, GET')
  // Based on https://github.com/primus/access-control/blob/4cf1bc0e54b086c91e6aa44fb14966fa5ef7549c/index.js#L158
  if (req.headers['access-control-request-headers']) {
    res.setHeader(
      'Access-Control-Allow-Headers',
      req.headers['access-control-request-headers'] as string
    )
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(200)
    res.end()
    return { preflight: true }
  }

  return { preflight: false }
}

const matchNextPageBundleRequest = getPathMatch(
  '/_next/static/chunks/pages/:path*.js(\\.map|)'
)

// Iteratively look up the issuer till it ends up at the root
function findEntryModule(
  module: webpack.Module,
  compilation: webpack.Compilation
): any {
  for (;;) {
    const issuer = compilation.moduleGraph.getIssuer(module)
    if (!issuer) return module
    module = issuer
  }
}

function erroredPages(compilation: webpack.Compilation) {
  const failedPages: { [page: string]: any[] } = {}
  for (const error of compilation.errors) {
    if (!error.module) {
      continue
    }

    const entryModule = findEntryModule(error.module, compilation)
    const { name } = entryModule
    if (!name) {
      continue
    }

    // Only pages have to be reloaded
    const enhancedName = getRouteFromEntrypoint(name)

    if (!enhancedName) {
      continue
    }

    if (!failedPages[enhancedName]) {
      failedPages[enhancedName] = []
    }

    failedPages[enhancedName].push(error)
  }

  return failedPages
}

export default class HotReloader {
  private dir: string
  private buildId: string
  private interceptors: any[]
  private pagesDir?: string
  private distDir: string
  private webpackHotMiddleware?: WebpackHotMiddleware
  private config: NextConfigComplete
  public hasServerComponents: boolean
  public clientStats: webpack.Stats | null
  public serverStats: webpack.Stats | null
  public edgeServerStats: webpack.Stats | null
  private clientError: Error | null = null
  private serverError: Error | null = null
  private serverPrevDocumentHash: string | null
  private prevChunkNames?: Set<any>
  private onDemandEntries?: ReturnType<typeof onDemandEntryHandler>
  private previewProps: __ApiPreviewProps
  private watcher: any
  private rewrites: CustomRoutes['rewrites']
  private fallbackWatcher: any
  private hotReloaderSpan: Span
  private pagesMapping: { [key: string]: string } = {}
  private appDir?: string
  private telemetry: Telemetry
  private versionInfo: VersionInfo = {
    staleness: 'unknown',
    installed: '0.0.0',
  }
  public multiCompiler?: webpack.MultiCompiler
  public activeConfigs?: Array<
    UnwrapPromise<ReturnType<typeof getBaseWebpackConfig>>
  >

  constructor(
    dir: string,
    {
      config,
      pagesDir,
      distDir,
      buildId,
      previewProps,
      rewrites,
      appDir,
      telemetry,
    }: {
      config: NextConfigComplete
      pagesDir?: string
      distDir: string
      buildId: string
      previewProps: __ApiPreviewProps
      rewrites: CustomRoutes['rewrites']
      appDir?: string
      telemetry: Telemetry
    }
  ) {
    this.buildId = buildId
    this.dir = dir
    this.interceptors = []
    this.pagesDir = pagesDir
    this.appDir = appDir
    this.distDir = distDir
    this.clientStats = null
    this.serverStats = null
    this.edgeServerStats = null
    this.serverPrevDocumentHash = null
    this.telemetry = telemetry

    this.config = config
    this.hasServerComponents = !!this.appDir
    this.previewProps = previewProps
    this.rewrites = rewrites
    this.hotReloaderSpan = trace('hot-reloader', undefined, {
      version: process.env.__NEXT_VERSION as string,
    })
    // Ensure the hotReloaderSpan is flushed immediately as it's the parentSpan for all processing
    // of the current `next dev` invocation.
    this.hotReloaderSpan.stop()
  }

  public async run(
    req: IncomingMessage,
    res: ServerResponse,
    parsedUrl: UrlObject
  ): Promise<{ finished?: true }> {
    // Usually CORS support is not needed for the hot-reloader (this is dev only feature)
    // With when the app runs for multi-zones support behind a proxy,
    // the current page is trying to access this URL via assetPrefix.
    // That's when the CORS support is needed.
    const { preflight } = addCorsSupport(req, res)
    if (preflight) {
      return {}
    }

    // When a request comes in that is a page bundle, e.g. /_next/static/<buildid>/pages/index.js
    // we have to compile the page using on-demand-entries, this middleware will handle doing that
    // by adding the page to on-demand-entries, waiting till it's done
    // and then the bundle will be served like usual by the actual route in server/index.js
    const handlePageBundleRequest = async (
      pageBundleRes: ServerResponse,
      parsedPageBundleUrl: UrlObject
    ): Promise<{ finished?: true }> => {
      const { pathname } = parsedPageBundleUrl
      const params = matchNextPageBundleRequest<{ path: string[] }>(pathname)
      if (!params) {
        return {}
      }

      let decodedPagePath: string

      try {
        decodedPagePath = `/${params.path
          .map((param) => decodeURIComponent(param))
          .join('/')}`
      } catch (_) {
        throw new DecodeError('failed to decode param')
      }

      const page = denormalizePagePath(decodedPagePath)

      if (page === '/_error' || BLOCKED_PAGES.indexOf(page) === -1) {
        try {
          await this.ensurePage({ page, clientOnly: true })
        } catch (error) {
          return await renderScriptError(pageBundleRes, getProperError(error))
        }

        const errors = await this.getCompilationErrors(page)
        if (errors.length > 0) {
          return await renderScriptError(pageBundleRes, errors[0], {
            verbose: false,
          })
        }
      }

      return {}
    }

    const { finished } = await handlePageBundleRequest(res, parsedUrl)

    for (const fn of this.interceptors) {
      await new Promise<void>((resolve, reject) => {
        fn(req, res, (err: Error) => {
          if (err) return reject(err)
          resolve()
        })
      })
    }

    return { finished }
  }

  public onHMR(req: IncomingMessage, _res: ServerResponse, head: Buffer) {
    wsServer.handleUpgrade(req, req.socket, head, (client) => {
      this.webpackHotMiddleware?.onHMR(client)
      this.onDemandEntries?.onHMR(client)

      client.addEventListener('message', ({ data }) => {
        data = typeof data !== 'string' ? data.toString() : data

        try {
          const payload = JSON.parse(data)

          let traceChild:
            | {
                name: string
                startTime?: bigint
                endTime?: bigint
                attrs?: Record<string, number | string>
              }
            | undefined

          switch (payload.event) {
            case 'client-hmr-latency': {
              traceChild = {
                name: payload.event,
                startTime: BigInt(payload.startTime) * BigInt(1000 * 1000),
                endTime: BigInt(payload.endTime) * BigInt(1000 * 1000),
              }
              break
            }
            case 'client-reload-page':
            case 'client-success': {
              traceChild = {
                name: payload.event,
              }
              break
            }
            case 'client-error': {
              traceChild = {
                name: payload.event,
                attrs: { errorCount: payload.errorCount },
              }
              break
            }
            case 'client-warning': {
              traceChild = {
                name: payload.event,
                attrs: { warningCount: payload.warningCount },
              }
              break
            }
            case 'client-removed-page':
            case 'client-added-page': {
              traceChild = {
                name: payload.event,
                attrs: { page: payload.page || '' },
              }
              break
            }
            case 'client-full-reload': {
              const { event, stackTrace, hadRuntimeError } = payload

              traceChild = {
                name: event,
                attrs: { stackTrace: stackTrace ?? '' },
              }

              if (hadRuntimeError) {
                Log.warn(
                  `Fast Refresh had to perform a full reload due to a runtime error.`
                )
                break
              }

              let fileMessage = ''
              if (stackTrace) {
                const file = /Aborted because (.+) is not accepted/.exec(
                  stackTrace
                )?.[1]
                if (file) {
                  // `file` is filepath in `pages/` but it can be weird long webpack url in `app/`.
                  // If it's a webpack loader URL, it will start with '(app-client)/./'
                  if (file.startsWith('(app-client)/./')) {
                    const fileUrl = new URL(file, 'file://')
                    const cwd = process.cwd()
                    const modules = fileUrl.searchParams
                      .getAll('modules')
                      .map((filepath) => filepath.slice(cwd.length + 1))
                      .filter(
                        (filepath) => !filepath.startsWith('node_modules')
                      )

                    if (modules.length > 0) {
                      fileMessage = ` when ${modules.join(', ')} changed`
                    }
                  } else {
                    fileMessage = ` when ${file} changed`
                  }
                }
              }

              Log.warn(
                `Fast Refresh had to perform a full reload${fileMessage}. Read more: https://nextjs.org/docs/messages/fast-refresh-reload`
              )
              break
            }
            default: {
              break
            }
          }

          if (traceChild) {
            this.hotReloaderSpan.manualTraceChild(
              traceChild.name,
              traceChild.startTime || process.hrtime.bigint(),
              traceChild.endTime || process.hrtime.bigint(),
              { ...traceChild.attrs, clientId: payload.id }
            )
          }
        } catch (_) {
          // invalid WebSocket message
        }
      })
    })
  }

  private async clean(span: Span): Promise<void> {
    return span
      .traceChild('clean')
      .traceAsyncFn(() =>
        recursiveDelete(join(this.dir, this.config.distDir), /^cache/)
      )
  }

  private async getVersionInfo(span: Span, enabled: boolean) {
    const versionInfoSpan = span.traceChild('get-version-info')
    return versionInfoSpan.traceAsyncFn<VersionInfo>(async () => {
      let installed = '0.0.0'

      if (!enabled) {
        return { installed, staleness: 'unknown' }
      }

      try {
        installed = require('next/package.json').version

        const registry = getRegistry()
        const res = await fetch(`${registry}-/package/next/dist-tags`)

        if (!res.ok) return { installed, staleness: 'unknown' }

        const tags = await res.json()

        return parseVersionInfo({
          installed,
          latest: tags.latest,
          canary: tags.canary,
        })
      } catch {
        return { installed, staleness: 'unknown' }
      }
    })
  }

  private async getWebpackConfig(span: Span) {
    const webpackConfigSpan = span.traceChild('get-webpack-config')

    const pageExtensions = this.config.pageExtensions

    return webpackConfigSpan.traceAsyncFn(async () => {
      const pagePaths = !this.pagesDir
        ? ([] as (string | null)[])
        : await webpackConfigSpan
            .traceChild('get-page-paths')
            .traceAsyncFn(() =>
              Promise.all([
                findPageFile(this.pagesDir!, '/_app', pageExtensions, false),
                findPageFile(
                  this.pagesDir!,
                  '/_document',
                  pageExtensions,
                  false
                ),
              ])
            )

      this.pagesMapping = webpackConfigSpan
        .traceChild('create-pages-mapping')
        .traceFn(() =>
          createPagesMapping({
            isDev: true,
            pageExtensions: this.config.pageExtensions,
            pagesType: 'pages',
            pagePaths: pagePaths.filter(
              (i: string | null): i is string => typeof i === 'string'
            ),
            pagesDir: this.pagesDir,
          })
        )

      const entrypoints = await webpackConfigSpan
        .traceChild('create-entrypoints')
        .traceAsyncFn(() =>
          createEntrypoints({
            appDir: this.appDir,
            buildId: this.buildId,
            config: this.config,
            envFiles: [],
            isDev: true,
            pages: this.pagesMapping,
            pagesDir: this.pagesDir,
            previewMode: this.previewProps,
            rootDir: this.dir,
            pageExtensions: this.config.pageExtensions,
          })
        )

      const commonWebpackOptions = {
        dev: true,
        buildId: this.buildId,
        config: this.config,
        pagesDir: this.pagesDir,
        rewrites: this.rewrites,
        originalRewrites: this.config._originalRewrites,
        originalRedirects: this.config._originalRedirects,
        runWebpackSpan: this.hotReloaderSpan,
        appDir: this.appDir,
      }

      return webpackConfigSpan
        .traceChild('generate-webpack-config')
        .traceAsyncFn(async () => {
          const info = await loadProjectInfo({
            dir: this.dir,
            config: commonWebpackOptions.config,
            dev: true,
          })
          return Promise.all([
            // order is important here
            getBaseWebpackConfig(this.dir, {
              ...commonWebpackOptions,
              compilerType: COMPILER_NAMES.client,
              entrypoints: entrypoints.client,
              ...info,
            }),
            getBaseWebpackConfig(this.dir, {
              ...commonWebpackOptions,
              compilerType: COMPILER_NAMES.server,
              entrypoints: entrypoints.server,
              ...info,
            }),
            getBaseWebpackConfig(this.dir, {
              ...commonWebpackOptions,
              compilerType: COMPILER_NAMES.edgeServer,
              entrypoints: entrypoints.edgeServer,
              ...info,
            }),
          ])
        })
    })
  }

  public async buildFallbackError(): Promise<void> {
    if (this.fallbackWatcher) return

    const info = await loadProjectInfo({
      dir: this.dir,
      config: this.config,
      dev: true,
    })
    const fallbackConfig = await getBaseWebpackConfig(this.dir, {
      runWebpackSpan: this.hotReloaderSpan,
      dev: true,
      compilerType: COMPILER_NAMES.client,
      config: this.config,
      buildId: this.buildId,
      pagesDir: this.pagesDir,
      rewrites: {
        beforeFiles: [],
        afterFiles: [],
        fallback: [],
      },
      originalRewrites: {
        beforeFiles: [],
        afterFiles: [],
        fallback: [],
      },
      originalRedirects: [],
      isDevFallback: true,
      entrypoints: (
        await createEntrypoints({
          appDir: this.appDir,
          buildId: this.buildId,
          config: this.config,
          envFiles: [],
          isDev: true,
          pages: {
            '/_app': 'next/dist/pages/_app',
            '/_error': 'next/dist/pages/_error',
          },
          pagesDir: this.pagesDir,
          previewMode: this.previewProps,
          rootDir: this.dir,
          pageExtensions: this.config.pageExtensions,
        })
      ).client,
      ...info,
    })
    const fallbackCompiler = webpack(fallbackConfig)

    this.fallbackWatcher = await new Promise((resolve) => {
      let bootedFallbackCompiler = false
      fallbackCompiler.watch(
        // @ts-ignore webpack supports an array of watchOptions when using a multiCompiler
        fallbackConfig.watchOptions,
        // Errors are handled separately
        (_err: any) => {
          if (!bootedFallbackCompiler) {
            bootedFallbackCompiler = true
            resolve(true)
          }
        }
      )
    })
  }

  public async start(): Promise<void> {
    const startSpan = this.hotReloaderSpan.traceChild('start')
    startSpan.stop() // Stop immediately to create an artificial parent span

    this.versionInfo = await this.getVersionInfo(
      startSpan,
      !!process.env.NEXT_TEST_MODE || this.telemetry.isEnabled
    )

    await this.clean(startSpan)
    // Ensure distDir exists before writing package.json
    await fs.mkdir(this.distDir, { recursive: true })

    const distPackageJsonPath = join(this.distDir, 'package.json')
    // Ensure commonjs handling is used for files in the distDir (generally .next)
    // Files outside of the distDir can be "type": "module"
    await fs.writeFile(distPackageJsonPath, '{"type": "commonjs"}')

    this.activeConfigs = await this.getWebpackConfig(startSpan)

    for (const config of this.activeConfigs) {
      const defaultEntry = config.entry
      config.entry = async (...args) => {
        const outputPath = this.multiCompiler?.outputPath || ''
        const entries = getEntries(outputPath)
        // @ts-ignore entry is always a function
        const entrypoints = await defaultEntry(...args)
        const isClientCompilation = config.name === COMPILER_NAMES.client
        const isNodeServerCompilation = config.name === COMPILER_NAMES.server
        const isEdgeServerCompilation =
          config.name === COMPILER_NAMES.edgeServer

        await Promise.all(
          Object.keys(entries).map(async (entryKey) => {
            const entryData = entries[entryKey]
            const { bundlePath, dispose } = entryData

            const result =
              /^(client|server|edge-server)@(app|pages|root)@(.*)/g.exec(
                entryKey
              )
            const [, key /* pageType */, , page] = result! // this match should always happen

            if (key === COMPILER_NAMES.client && !isClientCompilation) return
            if (key === COMPILER_NAMES.server && !isNodeServerCompilation)
              return
            if (key === COMPILER_NAMES.edgeServer && !isEdgeServerCompilation)
              return

            const isEntry = entryData.type === EntryTypes.ENTRY
            const isChildEntry = entryData.type === EntryTypes.CHILD_ENTRY

            // Check if the page was removed or disposed and remove it
            if (isEntry) {
              const pageExists =
                !dispose && (await fileExists(entryData.absolutePagePath))
              if (!pageExists) {
                delete entries[entryKey]
                return
              }
            }

            // For child entries, if it has an entry file and it's gone, remove it
            if (isChildEntry) {
              if (entryData.absoluteEntryFilePath) {
                const pageExists =
                  !dispose &&
                  (await fileExists(entryData.absoluteEntryFilePath))
                if (!pageExists) {
                  delete entries[entryKey]
                  return
                }
              }
            }

            const hasAppDir = !!this.appDir
            const isAppPath = hasAppDir && bundlePath.startsWith('app/')
            const staticInfo = isEntry
              ? await getPageStaticInfo({
                  pageFilePath: entryData.absolutePagePath,
                  nextConfig: this.config,
                  isDev: true,
                  pageType: isAppPath ? 'app' : 'pages',
                })
              : {}
            const isServerComponent =
              isAppPath && staticInfo.rsc !== RSC_MODULE_TYPES.client

            const pageType = entryData.bundlePath.startsWith('pages/')
              ? 'pages'
              : entryData.bundlePath.startsWith('app/')
              ? 'app'
              : 'root'
            await runDependingOnPageType({
              page,
              pageRuntime: staticInfo.runtime,
              pageType,
              onEdgeServer: () => {
                // TODO-APP: verify if child entry should support.
                if (!isEdgeServerCompilation || !isEntry) return
                const appDirLoader = isAppPath
                  ? getAppEntry({
                      name: bundlePath,
                      appPaths: entryData.appPaths,
                      pagePath: posix.join(
                        APP_DIR_ALIAS,
                        relative(
                          this.appDir!,
                          entryData.absolutePagePath
                        ).replace(/\\/g, '/')
                      ),
                      appDir: this.appDir!,
                      pageExtensions: this.config.pageExtensions,
                      rootDir: this.dir,
                      isDev: true,
                      tsconfigPath: this.config.typescript.tsconfigPath,
                      assetPrefix: this.config.assetPrefix,
                    }).import
                  : undefined

                entries[entryKey].status = BUILDING
                entrypoints[bundlePath] = finalizeEntrypoint({
                  compilerType: COMPILER_NAMES.edgeServer,
                  name: bundlePath,
                  value: getEdgeServerEntry({
                    absolutePagePath: entryData.absolutePagePath,
                    rootDir: this.dir,
                    buildId: this.buildId,
                    bundlePath,
                    config: this.config,
                    isDev: true,
                    page,
                    pages: this.pagesMapping,
                    isServerComponent,
                    appDirLoader,
                    pagesType: isAppPath ? 'app' : 'pages',
                  }),
                  hasAppDir,
                })
              },
              onClient: () => {
                if (!isClientCompilation) return
                if (isChildEntry) {
                  entries[entryKey].status = BUILDING
                  entrypoints[bundlePath] = finalizeEntrypoint({
                    name: bundlePath,
                    compilerType: COMPILER_NAMES.client,
                    value: entryData.request,
                    hasAppDir,
                  })
                } else {
                  entries[entryKey].status = BUILDING
                  entrypoints[bundlePath] = finalizeEntrypoint({
                    name: bundlePath,
                    compilerType: COMPILER_NAMES.client,
                    value: getClientEntry({
                      absolutePagePath: entryData.absolutePagePath,
                      page,
                    }),
                    hasAppDir,
                  })
                }
              },
              onServer: () => {
                // TODO-APP: verify if child entry should support.
                if (!isNodeServerCompilation || !isEntry) return
                entries[entryKey].status = BUILDING
                let relativeRequest = relative(
                  config.context!,
                  entryData.absolutePagePath
                )
                if (
                  !isAbsolute(relativeRequest) &&
                  !relativeRequest.startsWith('../')
                ) {
                  relativeRequest = `./${relativeRequest}`
                }
                entrypoints[bundlePath] = finalizeEntrypoint({
                  compilerType: COMPILER_NAMES.server,
                  name: bundlePath,
                  isServerComponent,
                  value: isAppPath
                    ? getAppEntry({
                        name: bundlePath,
                        appPaths: entryData.appPaths,
                        pagePath: posix.join(
                          APP_DIR_ALIAS,
                          relative(
                            this.appDir!,
                            entryData.absolutePagePath
                          ).replace(/\\/g, '/')
                        ),
                        appDir: this.appDir!,
                        pageExtensions: this.config.pageExtensions,
                        rootDir: this.dir,
                        isDev: true,
                        tsconfigPath: this.config.typescript.tsconfigPath,
                        assetPrefix: this.config.assetPrefix,
                      })
                    : relativeRequest,
                  hasAppDir,
                })
              },
            })
          })
        )
        return entrypoints
      }
    }

    // Enable building of client compilation before server compilation in development
    // @ts-ignore webpack 5
    this.activeConfigs.parallelism = 1

    this.multiCompiler = webpack(
      this.activeConfigs
    ) as unknown as webpack.MultiCompiler

    watchCompilers(
      this.multiCompiler.compilers[0],
      this.multiCompiler.compilers[1],
      this.multiCompiler.compilers[2]
    )

    // Watch for changes to client/server page files so we can tell when just
    // the server file changes and trigger a reload for GS(S)P pages
    const changedClientPages = new Set<string>()
    const changedServerPages = new Set<string>()
    const changedEdgeServerPages = new Set<string>()

    const changedServerComponentPages = new Set<string>()
    const changedCSSImportPages = new Set<string>()

    const prevClientPageHashes = new Map<string, string>()
    const prevServerPageHashes = new Map<string, string>()
    const prevEdgeServerPageHashes = new Map<string, string>()
    const prevCSSImportModuleHashes = new Map<string, string>()

    const trackPageChanges =
      (
        pageHashMap: Map<string, string>,
        changedItems: Set<string>,
        serverComponentChangedItems?: Set<string>
      ) =>
      (stats: webpack.Compilation) => {
        try {
          stats.entrypoints.forEach((entry, key) => {
            if (
              key.startsWith('pages/') ||
              key.startsWith('app/') ||
              isMiddlewareFilename(key)
            ) {
              // TODO this doesn't handle on demand loaded chunks
              entry.chunks.forEach((chunk) => {
                if (chunk.id === key) {
                  const modsIterable: any =
                    stats.chunkGraph.getChunkModulesIterable(chunk)

                  let hasCSSModuleChanges = false
                  let chunksHash = new StringXor()
                  let chunksHashServerLayer = new StringXor()

                  modsIterable.forEach((mod: any) => {
                    if (
                      mod.resource &&
                      mod.resource.replace(/\\/g, '/').includes(key)
                    ) {
                      // use original source to calculate hash since mod.hash
                      // includes the source map in development which changes
                      // every time for both server and client so we calculate
                      // the hash without the source map for the page module
                      const hash = require('crypto')
                        .createHash('sha256')
                        .update(mod.originalSource().buffer())
                        .digest()
                        .toString('hex')

                      if (
                        mod.layer === WEBPACK_LAYERS.server &&
                        mod?.buildInfo?.rsc?.type !== 'client'
                      ) {
                        chunksHashServerLayer.add(hash)
                      }

                      chunksHash.add(hash)
                    } else {
                      // for non-pages we can use the module hash directly
                      const hash = stats.chunkGraph.getModuleHash(
                        mod,
                        chunk.runtime
                      )

                      if (
                        mod.layer === WEBPACK_LAYERS.server &&
                        mod?.buildInfo?.rsc?.type !== 'client'
                      ) {
                        chunksHashServerLayer.add(hash)
                      }

                      chunksHash.add(hash)

                      // Both CSS import changes from server and client
                      // components are tracked.
                      if (
                        key.startsWith('app/') &&
                        mod.resource?.endsWith('.css')
                      ) {
                        const prevHash = prevCSSImportModuleHashes.get(
                          mod.resource
                        )
                        if (prevHash && prevHash !== hash) {
                          hasCSSModuleChanges = true
                        }
                        prevCSSImportModuleHashes.set(mod.resource, hash)
                      }
                    }
                  })

                  const prevHash = pageHashMap.get(key)
                  const curHash = chunksHash.toString()
                  if (prevHash && prevHash !== curHash) {
                    changedItems.add(key)
                  }
                  pageHashMap.set(key, curHash)

                  if (serverComponentChangedItems) {
                    const serverKey = WEBPACK_LAYERS.server + ':' + key
                    const prevServerHash = pageHashMap.get(serverKey)
                    const curServerHash = chunksHashServerLayer.toString()
                    if (prevServerHash && prevServerHash !== curServerHash) {
                      serverComponentChangedItems.add(key)
                    }
                    pageHashMap.set(serverKey, curServerHash)
                  }

                  if (hasCSSModuleChanges) {
                    changedCSSImportPages.add(key)
                  }
                }
              })
            }
          })
        } catch (err) {
          console.error(err)
        }
      }

    this.multiCompiler.compilers[0].hooks.emit.tap(
      'NextjsHotReloaderForClient',
      trackPageChanges(prevClientPageHashes, changedClientPages)
    )
    this.multiCompiler.compilers[1].hooks.emit.tap(
      'NextjsHotReloaderForServer',
      trackPageChanges(
        prevServerPageHashes,
        changedServerPages,
        changedServerComponentPages
      )
    )
    this.multiCompiler.compilers[2].hooks.emit.tap(
      'NextjsHotReloaderForServer',
      trackPageChanges(
        prevEdgeServerPageHashes,
        changedEdgeServerPages,
        changedServerComponentPages
      )
    )

    // This plugin watches for changes to _document.js and notifies the client side that it should reload the page
    this.multiCompiler.compilers[1].hooks.failed.tap(
      'NextjsHotReloaderForServer',
      (err: Error) => {
        this.serverError = err
        this.serverStats = null
      }
    )

    this.multiCompiler.compilers[2].hooks.done.tap(
      'NextjsHotReloaderForServer',
      (stats) => {
        this.serverError = null
        this.edgeServerStats = stats
      }
    )

    this.multiCompiler.compilers[1].hooks.done.tap(
      'NextjsHotReloaderForServer',
      (stats) => {
        this.serverError = null
        this.serverStats = stats

        if (!this.pagesDir) {
          return
        }

        const { compilation } = stats

        // We only watch `_document` for changes on the server compilation
        // the rest of the files will be triggered by the client compilation
        const documentChunk = compilation.namedChunks.get('pages/_document')
        // If the document chunk can't be found we do nothing
        if (!documentChunk) {
          console.warn('_document.js chunk not found')
          return
        }

        // Initial value
        if (this.serverPrevDocumentHash === null) {
          this.serverPrevDocumentHash = documentChunk.hash || null
          return
        }

        // If _document.js didn't change we don't trigger a reload
        if (documentChunk.hash === this.serverPrevDocumentHash) {
          return
        }

        // Notify reload to reload the page, as _document.js was changed (different hash)
        this.send('reloadPage')
        this.serverPrevDocumentHash = documentChunk.hash || null
      }
    )
    this.multiCompiler.hooks.done.tap('NextjsHotReloaderForServer', () => {
      const serverOnlyChanges = difference<string>(
        changedServerPages,
        changedClientPages
      )
      const edgeServerOnlyChanges = difference<string>(
        changedEdgeServerPages,
        changedClientPages
      )

      const pageChanges = serverOnlyChanges
        .concat(edgeServerOnlyChanges)
        .filter((key) => key.startsWith('pages/'))
      const middlewareChanges = Array.from(changedEdgeServerPages).filter(
        (name) => isMiddlewareFilename(name)
      )

      if (middlewareChanges.length > 0) {
        this.send({
          event: 'middlewareChanges',
        })
      }

      if (pageChanges.length > 0) {
        this.send({
          event: 'serverOnlyChanges',
          pages: serverOnlyChanges.map((pg) =>
            denormalizePagePath(pg.slice('pages'.length))
          ),
        })
      }

      if (changedServerComponentPages.size || changedCSSImportPages.size) {
        this.send({
          action: 'serverComponentChanges',
          // TODO: granular reloading of changes
          // entrypoints: serverComponentChanges,
        })
      }

      changedClientPages.clear()
      changedServerPages.clear()
      changedEdgeServerPages.clear()
      changedServerComponentPages.clear()
      changedCSSImportPages.clear()
    })

    this.multiCompiler.compilers[0].hooks.failed.tap(
      'NextjsHotReloaderForClient',
      (err: Error) => {
        this.clientError = err
        this.clientStats = null
      }
    )
    this.multiCompiler.compilers[0].hooks.done.tap(
      'NextjsHotReloaderForClient',
      (stats) => {
        this.clientError = null
        this.clientStats = stats

        const { compilation } = stats
        const chunkNames = new Set(
          [...compilation.namedChunks.keys()].filter(
            (name) => !!getRouteFromEntrypoint(name)
          )
        )

        if (this.prevChunkNames) {
          // detect chunks which have to be replaced with a new template
          // e.g, pages/index.js <-> pages/_error.js
          const addedPages = diff(chunkNames, this.prevChunkNames!)
          const removedPages = diff(this.prevChunkNames!, chunkNames)

          if (addedPages.size > 0) {
            for (const addedPage of addedPages) {
              const page = getRouteFromEntrypoint(addedPage)
              this.send('addedPage', page)
            }
          }

          if (removedPages.size > 0) {
            for (const removedPage of removedPages) {
              const page = getRouteFromEntrypoint(removedPage)
              this.send('removedPage', page)
            }
          }
        }

        this.prevChunkNames = chunkNames
      }
    )

    this.webpackHotMiddleware = new WebpackHotMiddleware(
      this.multiCompiler.compilers,
      this.versionInfo
    )

    let booted = false

    this.watcher = await new Promise((resolve) => {
      const watcher = this.multiCompiler?.watch(
        // @ts-ignore webpack supports an array of watchOptions when using a multiCompiler
        this.activeConfigs.map((config) => config.watchOptions!),
        // Errors are handled separately
        (_err: any) => {
          if (!booted) {
            booted = true
            resolve(watcher)
          }
        }
      )
    })

    this.onDemandEntries = onDemandEntryHandler({
      multiCompiler: this.multiCompiler,
      pagesDir: this.pagesDir,
      appDir: this.appDir,
      rootDir: this.dir,
      nextConfig: this.config,
      ...(this.config.onDemandEntries as {
        maxInactiveAge: number
        pagesBufferLength: number
      }),
    })

    this.interceptors = [
      getOverlayMiddleware({
        rootDirectory: this.dir,
        stats: () => this.clientStats,
        serverStats: () => this.serverStats,
        edgeServerStats: () => this.edgeServerStats,
      }),
    ]
  }

  public invalidate() {
    const outputPath = this.multiCompiler?.outputPath
    return outputPath && getInvalidator(outputPath)?.invalidate()
  }

  public async stop(): Promise<void> {
    await new Promise((resolve, reject) => {
      this.watcher.close((err: any) => (err ? reject(err) : resolve(true)))
    })

    if (this.fallbackWatcher) {
      await new Promise((resolve, reject) => {
        this.fallbackWatcher.close((err: any) =>
          err ? reject(err) : resolve(true)
        )
      })
    }
    this.multiCompiler = undefined
  }

  public async getCompilationErrors(page: string) {
    const getErrors = ({ compilation }: webpack.Stats) => {
      const failedPages = erroredPages(compilation)
      const normalizedPage = normalizePathSep(page)
      // If there is an error related to the requesting page we display it instead of the first error
      return failedPages[normalizedPage]?.length > 0
        ? failedPages[normalizedPage]
        : compilation.errors
    }

    if (this.clientError || this.serverError) {
      return [this.clientError || this.serverError]
    } else if (this.clientStats?.hasErrors()) {
      return getErrors(this.clientStats)
    } else if (this.serverStats?.hasErrors()) {
      return getErrors(this.serverStats)
    } else if (this.edgeServerStats?.hasErrors()) {
      return getErrors(this.edgeServerStats)
    } else {
      return []
    }
  }

  public send(action?: string | any, ...args: any[]): void {
    this.webpackHotMiddleware!.publish(
      action && typeof action === 'object' ? action : { action, data: args }
    )
  }

  public async ensurePage({
    page,
    clientOnly,
    appPaths,
    match,
  }: {
    page: string
    clientOnly: boolean
    appPaths?: string[] | null
    match?: RouteMatch
  }): Promise<void> {
    // Make sure we don't re-build or dispose prebuilt pages
    if (page !== '/_error' && BLOCKED_PAGES.indexOf(page) !== -1) {
      return
    }
    const error = clientOnly
      ? this.clientError
      : this.serverError || this.clientError
    if (error) {
      return Promise.reject(error)
    }
    return this.onDemandEntries?.ensurePage({
      page,
      clientOnly,
      appPaths,
      match,
    }) as any
  }
}