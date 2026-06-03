// webpack.config.js
const webpack = require('webpack');
require('dotenv').config();

module.exports = {
  devtool: "source-map",
  plugins: [
    new webpack.DefinePlugin({
      'process.env.AZURE_FUNCTION_URL': JSON.stringify(process.env.AZURE_FUNCTION_URL)
    })
  ]
};