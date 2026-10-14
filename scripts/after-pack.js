'use strict'

// afterPack 编排：先剥离多余 lproj（darwin），再跑打包完整性门禁。
// electron-builder 的 afterPack 钩子只接受单个函数，不能挂数组，所以两件事
// 在这里串起来 —— 新的 afterPack 步骤请加进 run 而不是另立配置键。

const stripLproj = require('./strip-lproj')
const { verifyPackedNodeModules } = require('./verify-packed-node-modules')

exports.default = async function afterPack (context) {
  await stripLproj.default(context)
  await verifyPackedNodeModules(context)
}
