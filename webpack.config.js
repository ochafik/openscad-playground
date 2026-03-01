import CopyPlugin from 'copy-webpack-plugin';
import webpack from 'webpack';
import WorkboxPlugin from 'workbox-webpack-plugin';

import fs from 'fs';
import path, { dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const isDev = process.env.NODE_ENV !== 'production';

// Check if the asm.js variant has been built
const hasAsmJs = fs.existsSync(path.resolve(__dirname, 'src/asmjs/openscad.js'));

// Shared worker webpack config factory
function makeWorkerConfig({ entry, filename }) {
  return {
    entry,
    output: {
      filename,
      path: path.resolve(__dirname, 'dist'),
      globalObject: 'self',
    },
    devtool: isDev ? 'source-map' : 'nosources-source-map',
    mode: 'production',
    target: 'webworker',
    module: {
      rules: [
        {
          test: /\.tsx?$/,
          use: {
            loader: 'ts-loader',
            options: {
              transpileOnly: true,
              compilerOptions: {
                module: 'esnext',
                moduleResolution: 'node',
                target: 'ES2022',
                lib: ['WebWorker', 'ES2022'],
                sourceMap: isDev,
                inlineSources: isDev
              }
            }
          },
          exclude: /node_modules/,
        },
        {
          test: /\.wasm$/,
          type: 'asset/resource'
        }
      ]
    },
    resolve: {
      extensions: ['.tsx', '.ts', '.js', '.mjs', '.wasm'],
      modules: [
        path.resolve(__dirname, 'src'),
        'node_modules'
      ],
      fallback: {
        fs: false,
        path: false,
        module: false
      }
    },
    externals: {
      'browserfs': 'BrowserFS'
    },
    plugins: [
      new webpack.EnvironmentPlugin({
        'process.env.NODE_ENV': 'development',
      }),
    ],
  };
}

/** @type {import('webpack').Configuration[]} */
const config = [
  {
    entry: './src/index.tsx',
    devtool: isDev ? 'source-map' : 'nosources-source-map',
    mode: isDev ? 'development' : 'production',
    target: 'web',
    // devtool: 'inline-source-map',
    module: {
      rules: [
        {
          test: /\.tsx?$/,
          use: {
            loader: 'ts-loader',
            options: {
              transpileOnly: true,
              compilerOptions: {
                module: 'esnext',
                moduleResolution: 'node',
                target: 'ES2022',
                lib: ['WebWorker', 'ES2022'],
                sourceMap: isDev,
                inlineSources: isDev
              }
            }
          },
          exclude: /node_modules/,
        },
        {
          test: /\.css$/i,
          use: [
            'style-loader',
            {
              loader: 'css-loader',
              options: { url: false },
            }
          ]
        },
        // {
        //   test: /\.(png|gif|woff|woff2|eot|ttf|svg)$/,
        //   loader: 'url-loader?limit=100000'
        // },
      ],
    },
    resolve: {
      extensions: ['.tsx', '.ts', '.js'],
    },
    output: {
      filename: 'index.js',
      path: path.resolve(__dirname, 'dist'),
    },
    devServer: {
      static: path.join(__dirname, 'dist'),
      compress: true,
      port: 4000,
    },
    plugins: [
      new webpack.EnvironmentPlugin({
        'process.env.NODE_ENV': 'development',
      }),
      ...(process.env.NODE_ENV === 'production' ? [
        new WorkboxPlugin.GenerateSW({
          exclude: [
            /(^|\/)\./,
            /\.map$/,
            /^manifest.*\.js$/,
          ],
          // these options encourage the ServiceWorkers to get in there fast
          // and not allow any straggling 'old' SWs to hang around
          swDest: path.join(__dirname, 'dist', 'sw.js'),
          maximumFileSizeToCacheInBytes: 200 * 1024 * 1024,
          clientsClaim: true,
          skipWaiting: true,
          runtimeCaching: [{
            urlPattern: ({ request, url }) => true,
            handler: 'StaleWhileRevalidate',
            options: {
              cacheName: 'all',
              expiration: {
                maxEntries: 1000,
                purgeOnQuotaError: true,
              },
            },
          }],
        }),
      ] : []),
      new CopyPlugin({
        patterns: [
          {
            from: path.resolve(__dirname, 'public'),
            toType: 'dir',
          },
          {
            from: path.resolve(__dirname, 'node_modules/primeicons/fonts'),
            to: path.resolve(__dirname, 'dist/fonts'),
            toType: 'dir',
          },
          {
            from: path.resolve(__dirname, 'src/wasm/openscad.js'),
            to: path.resolve(__dirname, 'dist'),
          },
          {
            from: path.resolve(__dirname, 'src/wasm/openscad.wasm'),
            to: path.resolve(__dirname, 'dist'),
          },
        ],
      }),
    ],
  },
  // WASM worker (always built)
  makeWorkerConfig({
    entry: './src/runner/openscad-worker.ts',
    filename: 'openscad-worker.js',
  }),

  // asm.js worker (only built if src/asmjs/openscad.js exists)
  ...(hasAsmJs ? [
    makeWorkerConfig({
      entry: './src/runner/openscad-worker-asmjs.ts',
      filename: 'openscad-worker-asmjs.js',
    }),
  ] : []),
];

export default config;
