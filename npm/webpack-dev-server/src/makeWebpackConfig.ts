import { debug as debugFn } from 'debug'
import * as path from 'path'
import { merge } from 'webpack-merge'
import { importModule } from 'local-pkg'
import type { Configuration } from 'webpack'
import { makeDefaultWebpackConfig } from './makeDefaultWebpackConfig'
import { CypressCTWebpackPlugin } from './CypressCTWebpackPlugin'
import type { CreateFinalWebpackConfig } from './createWebpackDevServer'
import { configFiles } from './constants'

const debug = debugFn('cypress:webpack-dev-server:makeWebpackConfig')

const removeList = [
  // We provide a webpack-html-plugin config pinned to a specific version (4.x)
  // that we have tested and are confident works with all common configurations.
  // https://github.com/cypress-io/cypress/issues/15865
  'HtmlWebpackPlugin',

  // This plugin is an optimization for HtmlWebpackPlugin for use in
  // production environments, not relevant for testing.
  'PreloadPlugin',

  // Another optimization not relevant in a testing environment.
  'HtmlPwaPlugin',

  // We already reload when webpack recompiles (via listeners on
  // devServerEvents). Removing this plugin can prevent double-refreshes
  // in some setups.
  'HotModuleReplacementPlugin',
]

// CaseSensitivePathsPlugin checks the paths of every loaded module to enforce
// case sensitivity - this helps developers on mac catch issues that will bite
// them later, but on linux the OS already does this by default. The plugin
// is somewhat slow, accounting for ~15% of compile time on a couple of CRA
// based projects (where it's included by default) tested.
if (process.platform === 'linux') {
  removeList.push('CaseSensitivePathsPlugin')
}

const OsSeparatorRE = RegExp(`\\${path.sep}`, 'g')
const posixSeparator = '/'

const CYPRESS_WEBPACK_ENTRYPOINT = path.resolve(__dirname, 'browser.js')

/**
 * Removes and/or modifies certain plugins known to conflict
 * when used with cypress/webpack-dev-server.
 */
function modifyWebpackConfigForCypress (webpackConfig: Partial<Configuration>) {
  if (webpackConfig?.plugins) {
    webpackConfig.plugins = webpackConfig.plugins.filter((plugin) => {
      if (removeList.includes(plugin.constructor.name)) {
        /* eslint-disable no-console */
        console.warn(`[@cypress/webpack-dev-server]: removing ${plugin.constructor.name} from configuration.`)

        return false
      }

      return true
    })
  }

  if (typeof webpackConfig?.module?.unsafeCache === 'function') {
    const originalCachePredicate = webpackConfig.module.unsafeCache

    webpackConfig.module.unsafeCache = (module: any) => {
      return originalCachePredicate(module) && !/[\\/]webpack-dev-server[\\/]dist[\\/]browser\.js/.test(module.resource)
    }
  }

  return webpackConfig
}

async function addEntryPoint (webpackConfig: Configuration) {
  let entry = webpackConfig.entry

  if (typeof entry === 'function') {
    entry = await entry()
  }

  if (typeof entry === 'string') {
    entry = [entry, CYPRESS_WEBPACK_ENTRYPOINT]
  } else if (Array.isArray(entry)) {
    entry.push(CYPRESS_WEBPACK_ENTRYPOINT)
  } else if (typeof entry === 'object') {
    entry = {
      ...entry,
      ['cypress-entry']: CYPRESS_WEBPACK_ENTRYPOINT,
    }
  } else {
    entry = CYPRESS_WEBPACK_ENTRYPOINT
  }

  webpackConfig.entry = entry
}

/**
 * Creates a webpack 4/5 compatible webpack "configuration"
 * to pass to the sourced webpack function
 */
export async function makeWebpackConfig (
  config: CreateFinalWebpackConfig,
) {
  const { module: webpack } = config.sourceWebpackModulesResult.webpack
  let userWebpackConfig = config.devServerConfig.webpackConfig as Partial<Configuration>
  const frameworkWebpackConfig = config.frameworkConfig as Partial<Configuration>
  const {
    cypressConfig: {
      projectRoot,
      devServerPublicPathRoute,
      supportFile,
    },
    specs: files,
    devServerEvents,
  } = config.devServerConfig

  let configFile: string | undefined = undefined

  if (!userWebpackConfig && !frameworkWebpackConfig) {
    debug('Not user or framework webpack config received. Trying to automatically source it')

    const { default: findUp } = await importModule('find-up')

    configFile = await findUp(configFiles, { cwd: projectRoot } as { cwd: string })

    if (configFile) {
      debug('found webpack config %s', configFile)
      const sourcedConfig = await importModule(configFile)

      debug('config contains %o', sourcedConfig)
      if (sourcedConfig && typeof sourcedConfig === 'object') {
        userWebpackConfig = sourcedConfig.default ?? sourcedConfig
      }
    }

    if (!userWebpackConfig) {
      debug('could not find webpack.config!')
      if (config.devServerConfig?.onConfigNotFound) {
        config.devServerConfig.onConfigNotFound('webpack', projectRoot, configFiles)
        // The config process will be killed from the parent, but we want to early exit so we don't get
        // any additional errors related to not having a config
        process.exit(0)
      } else {
        throw new Error(`Your Cypress devServer config is missing a required webpackConfig property, since we could not automatically detect one.\nPlease add one to your ${config.devServerConfig.cypressConfig.configFile}`)
      }
    }
  }

  const userAndFrameworkWebpackConfig = modifyWebpackConfigForCypress(
    merge(frameworkWebpackConfig ?? {}, userWebpackConfig ?? {}),
  )

  debug(`User passed in user and framework webpack config with values %o`, userAndFrameworkWebpackConfig)
  debug(`New webpack entries %o`, files)
  debug(`Project root`, projectRoot)
  debug(`Support file`, supportFile)

  const publicPath = (path.sep === posixSeparator)
    ? path.join(devServerPublicPathRoute, posixSeparator)
    // The second line here replaces backslashes on windows with posix compatible slash
    // See https://github.com/cypress-io/cypress/issues/16097
    : path.join(devServerPublicPathRoute, posixSeparator)
    .replace(OsSeparatorRE, posixSeparator)

  const dynamicWebpackConfig = {
    output: {
      publicPath,
    },
    plugins: [
      new CypressCTWebpackPlugin({
        files,
        projectRoot,
        devServerEvents,
        supportFile,
        webpack,
      }),
    ],
  }

  const mergedConfig = merge(
    userAndFrameworkWebpackConfig,
    makeDefaultWebpackConfig(config),
    dynamicWebpackConfig,
  )

  await addEntryPoint(mergedConfig)

  debug('Merged webpack config %o', mergedConfig)

  if (process.env.WEBPACK_PERF_MEASURE) {
    // only for debugging
    const { measureWebpackPerformance } = require('./measureWebpackPerformance')

    return measureWebpackPerformance(mergedConfig)
  }

  return mergedConfig
}
