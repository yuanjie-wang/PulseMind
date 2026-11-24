// afterPack 编排：先剥离多余 lproj（darwin）、裁掉随包语言资源与 Windows 桌面
// 集成件、剥离 onnxruntime 异平台二进制，再跑打包完整性门禁。electron-builder
// 的 afterPack 钩子只接受单个函数，不能挂数组，所以这几件事在这里串起来 ——
// 新的 afterPack 步骤请加进 run 而不是另立配置键。
//
// 时序：afterPack 在打包后、签名前 —— 两步裁剪动的都是签名覆盖的文件，必须
// 留在这里，别挪到签名之后。全部裁剪都排在门禁之前，让「裁完是否仍自洽」成为
// 门禁的一部分。

const stripLproj = require('./strip-lproj')
const prunePackagedAssets = require('./prune-packaged-assets')
const stripOrtForeignArch = require('./strip-ort-foreign-arch')
const { verifyPackedNodeModules } = require('./verify-packed-node-modules')

exports.default = async function afterPack (context) {
  await stripLproj.default(context)
  await prunePackagedAssets.default(context)
  // 必须早于 verifyPackedNodeModules：裁剪只动 bin/ 下的原生二进制，不碰
  // package.json，但放在门禁前可以让「裁完是否仍自洽」成为门禁的一部分。
  await stripOrtForeignArch.default(context)
  await verifyPackedNodeModules(context)
}