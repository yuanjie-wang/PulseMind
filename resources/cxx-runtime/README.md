# cxx-runtime —— 随包的私有 C++ 运行库（linux-x64）

这里是**提交物**（不是 CI 现场生成的产物，与 `resources/asr-engine/` 相反）：
`prepare-asr-engine.js` 每次都要先校验它的 sha256 才开始拷贝，所以它必须先存在。

| 文件 | 大小 | sha256 |
| --- | --- | --- |
| `linux-x64/libpmcxx.so.6` | 1 767 576 B (1.7 MB) | `85964cabf42087d9145a99e3c45b904f0e2760002f8d4b1dc73d8382f122cc09` |

## 为什么需要它

目标机 UOS 20 = Debian 10 基线：`glibc 2.28` + `libstdc++` 只到 `GLIBCXX_3.4.25`
（GCC 8.3）。而 `sherpa-onnx` 的官方 linux 平台包（钉 1.12.40）虽然 glibc 只要
2.16，`sherpa-onnx.node` 却要 **`GLIBCXX_3.4.29`**（`std::__throw_bad_array_new_length`，
GCC 11 才引入）。装机表现是 `dlopen` 报 `version 'GLIBCXX_3.4.29' not found`，
语音输入整个不可用。降版本没用——1.10.46 / 1.11.5 / 1.12.0 逐文件解析出来同样是
3.4.29；1.13+ 连 glibc 都超。所以只能自己带一份 C++ 运行库。

## 为什么它叫 `libpmcxx.so.6` 而不是 `libstdc++.so.6`

**同名会被 SONAME 去重。** glibc 的 `_dl_lookup_map`（`elf/dl-load.c`）注释原文：

> If the requested name matches the soname of a loaded object, use that object.

Linux 进程里几乎必然已经加载了系统 `libstdc++.so.6`（node / Electron 本体就链着
它）。此时 `DT_NEEDED libstdc++.so.6` 会直接复用那个已加载对象，**根本不会打开**
随包的这一份，`RUNPATH=$ORIGIN` 也就不生效——结果还是 version not found。这与
`LD_PRELOAD`、`LD_LIBRARY_PATH`、启动脚本都无关，是加载器内部的复用逻辑。

所以这份副本的 `SONAME` 改成了 `libpmcxx.so.6`，并把引擎四个对象的 `DT_NEEDED`
一起改名过去：两份 libstdc++ 靠**不同 SONAME** 共存，各取所需。改名由
`prepare-asr-engine.js` 的 `patchDynstrName()` 完成（原地改 `.dynstr` 内容、
不动偏移，不需要 patchelf——CI 容器装不了 apt，patchelf 这条路本来也走不通）。

## 来源与许可

- 来源：conda-forge 的 **`libstdcxx-12.4.0-h8f9b012_2`** 包里的
  `x86_64-conda-linux-gnu/lib/libstdc++.so.6.0.30`（GCC 12.4.0 构建）。
- 许可：**GPL-3.0-or-later WITH GCC-exception-3.1**（libstdc++ 一直是这个组合）。
  GCC Runtime Library Exception 正是为「把这份运行库随程序一起分发」写的，
  随包再分发不触发 GPL 的传染性。
- 为什么不用发行版自带的那份：Ubuntu jammy 的 `libstdc++.so.6.0.30` 自身要
  `GLIBC_2.34`，装到 2.28 的机器上等于把失败从引擎挪到运行库身上。conda-forge
  这份自身只要 **`GLIBC_2.17`**，`NEEDED` 里没有 `libstdc++.so.6`（只有
  `libm/libc/ld-linux/libgcc_s`，libgcc_s 的 `GCC_` 需求最高 4.2.0，任何目标机都有）。

## 制作步骤（可复现）

1. 解出 `libstdc++.so.6.0.30`，**先**改 `.dynstr` 里的 `SONAME`
   `libstdc++.so.6` → `libpmcxx.so.6`（13 字节 < 14 字节，尾部补 NUL，等长原地替换）。
   这一步必须在第 2 步之前——截断后节头表就没了，按节名找 `.dynstr` 的写法会失效。
2. 截掉尾部 `.debug_*`：保留到最后一个 `PT_LOAD` 的 `p_offset + p_filesz`，
   并把 `e_shoff` / `e_shnum` / `e_shstrndx` 清零（12 216 712 B → 1 767 576 B）。
3. 落实 `LINUX_CXX.sha256`（`scripts/prepare-asr-engine.js`）——blob 换了不同步这里，
   `prepare` 会当场失败。

## 这份 blob 必须同时满足的四条

自动化门禁在 `scripts/check-linux-glibc.js`（它同时量引擎和提供方）：

1. `SONAME` = `libpmcxx.so.6`（否则引擎改名后加载器找不到它）；
2. 自身 `GLIBC` 需求 ≤ 2.28（实测 **2.17**）——超了就是把失败搬到运行库身上；
3. 定义到的 `GLIBCXX` ≥ 引擎需求（实测到 **3.4.30**，引擎要 3.4.29）；
4. 引擎对象里不得残留 `libstdc++.so.6` 的 `DT_NEEDED`——残留说明它还在用系统的，
   这时「随包自带」只是心理安慰。

跑一遍体检：

```bash
node scripts/check-linux-glibc.js dist/linux-unpacked --ceiling=2.28 --glibcxx-ceiling=3.4.25
```

引擎目录（`resources/asr-engine/linux-x64/`）在场私有运行库时，那几条 `.node`/`.so`
的 GLIBCXX 上限由提供方实测能力决定（而不是 3.4.25 的系统上限），并逐条核对
「提供 ≥ 需求」。
