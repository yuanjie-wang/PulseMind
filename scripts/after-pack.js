// afterPack 编排：先剥离多余 lproj（darwin）与 onnxruntime 异平台二进制，
// 再跑打包完整性门禁。electron-builder 的 afterPack 钩子只接受单个函数，
// 不能挂数组，所以这几件事在这里串起来 —— 新的 afterPack 步骤请加进 run
// 而不是另立配置键。

const stripLproj = require('./strip-lproj')
const stripOrtForeignArch = require('./strip-ort-foreign-arch')
const { verifyPackedNodeModules } = require('./verify-packed-node-modules')

exports.default = async function afterPack (context) {
  await stripLproj.default(context)
  // 必须早于 verifyPackedNodeModules：裁剪只动 bin/ 下的原生二进制，不碰
  // package.json，但放在门禁前可以让「裁完是否仍自洽」成为门禁的一部分。
  await stripOrtForeignArch.default(context)
  await verifyPackedNodeModules(context)
}
