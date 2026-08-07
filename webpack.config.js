const path = require("path");
const CopyPlugin = require("copy-webpack-plugin");

const SDK_BUNDLE = path.resolve(__dirname, "node_modules/osrs-sdk/_bundles/main.js");

module.exports = (env, argv) => ({
  mode: argv.mode === "production" ? "production" : "development",
  entry: "./src/index.ts",
  output: {
    filename: "main.js",
    path: path.resolve(__dirname, "dist"),
    publicPath: "",
    clean: true,
  },
  devtool: "source-map",
  devServer: {
    contentBase: path.join(__dirname, "dist"),
    compress: true,
    port: 8000,
  },
  resolve: {
    extensions: [".tsx", ".ts", ".js"],
  },
  plugins: [
    new CopyPlugin({
      patterns: [
        // src/public is a static root copied verbatim: index.html, manifest,
        // fonts, and the vendored models/images/sounds the SDK fetches at runtime.
        { from: "**/*", context: "src/public" },
        // Images/sounds the SDK bundle references by bare hashed filename.
        { from: "*.png", to: "", context: "node_modules/osrs-sdk/_bundles/", noErrorOnMissing: true },
        { from: "*.gif", to: "", context: "node_modules/osrs-sdk/_bundles/", noErrorOnMissing: true },
        { from: "*.ogg", to: "", context: "node_modules/osrs-sdk/_bundles/", noErrorOnMissing: true },
      ],
    }),
  ],
  module: {
    rules: [
      {
        test: /\.tsx?$/,
        use: "ts-loader",
        exclude: /node_modules/,
      },
      {
        // Point the SDK's asset loader at the vendored copies in src/public, and make
        // its model preload retain the parsed GLB instead of discarding it.
        test: (resource) => resource === SDK_BUNDLE,
        use: [
          path.resolve(__dirname, "build/local-assets-loader.js"),
          path.resolve(__dirname, "build/sdk-model-cache-loader.js"),
        ],
      },
      {
        test: /\.(png|svg|jpg|jpeg|gif|ogg|gltf|glb)$/i,
        type: "asset/resource",
      },
      {
        test: /\.html$/i,
        loader: "html-loader",
      },
    ],
  },
});
