# koishi-plugin-blind-watermark

[![npm](https://img.shields.io/npm/v/koishi-plugin-blind-watermark?style=flat-square)](https://www.npmjs.com/package/koishi-plugin-blind-watermark)

> **给图片打上「看不见」的水印，随时再取回来。**
> 把 [guofei9987/blind_watermark](https://github.com/guofei9987/blind_watermark) 搬进 Koishi：聊天里发图 / 引用图，一句话就能嵌入或提取盲水印。

盲水印（blind watermark）不是叠在图片上的文字，而是**直接写进图片频域**的信息：图片看起来和原图几乎没有区别（肉眼找不出差别），但用同样的密码随时能把水印原样读出来。加过水印的图即使被**缩放、裁剪、旋转、截屏、调亮度、轻度 PS**，水印依然能读出来 —— 适合给自媒体配图、内部资料、群里发的截图做**溯源标记**。

## ✨ 功能特性

- 📝 **文字水印**：`bwm.embed 版权所有 maimai` —— 把一句话写进图片，提取时原样读回来
- 🖼️ **图片水印**：`bwm.embed.logo` —— 用另一张图（建议黑底白字 64x64）当水印，提取出来就是那张图
- 🔍 **自动提取**：`bwm.extract` 不用记任何长度，插件按候选位宽依次尝试、用魔数 + 校验确认，命中才返回
- 🔒 **双密码**：图片密码 + 水印密码，密码不一致就提取不出来
- 📦 **自带算法库**：上游 `blind_watermark` 的 Python 源码直接放在 `python/` 下（0.4.4），不需要 `pip install blind_watermark`
- 🧵 **并发闸门**：打水印很吃 CPU，默认最多同时跑 2 个 python 进程，超出的排队
- 🧹 **临时文件自动清理**：`data/blind-watermark/tmp` 里的中间文件用完即删，残留超过 2 小时的会在下次调用时清掉
- 🩺 **环境自检**：启动时检查 python / numpy / opencv / pywt，缺什么直接在日志里给出 `pip install` 提示；也可以随时发 `bwm.info`
- 🧩 **可作为服务调用**：其它插件可以直接用 `ctx.bwm.embedText(buffer, text)` / `ctx.bwm.extractText(buffer)`

## 📦 安装

### 1. 装插件

```bash
# 在 Koishi 项目目录里
yarn add koishi-plugin-blind-watermark
```

或把本目录放进你的 Koishi 项目（本地开发：把 `node_modules/koishi-plugin-blind-watermark` 软链到本目录），再在控制台「插件配置」里添加。

### 2. 装 Python 依赖（必须）

本插件通过子进程调用 Python，需要 **Python 3.8+** 以及三个库：

```bash
pip install numpy opencv-python PyWavelets
```

装好后可以自检：

```bash
python python/bwm_cli.py info
# {"ok": true, "python": "3.11.1", "blindWatermark": "0.4.4", "numpy": "2.4.2", "opencv": "4.13.0", "pywt": "1.9.0"}
```

> `numpy` + `opencv-python` 负责图像运算，`PyWavelets`（import 名是 `pywt`）是小波变换。
> 如果服务器上的 python 不在 PATH 里，把配置项 **pythonPath** 填成绝对路径（如 `C:\Python311\python.exe`）。

## 🎮 使用方法

在群里（或控制台沙盒里）直接发命令：图片和命令一起发、或者先引用一张图再发命令都行。

| 命令 | 说明 |
| --- | --- |
| `bwm.embed <文字>` | 给图片打上文字盲水印，别名 `bwm.text` |
| `bwm.extract [位宽]` | 从图片里提取文字水印，别名 `bwm.read`（一般不用带参数） |
| `bwm.embed.logo` | 打图片水印：**引用载体图**，并把**水印图**一起发出来 |
| `bwm.extract.logo [宽x高]` | 提取图片水印，别名 `bwm.readLogo`（不给尺寸就用配置里的 `logoShape`） |
| `bwm.info` | 环境自检，打印 python / 各库版本 |

```
# 文字水印
bwm.embed 版权所有 maimai 2026
（机器人回复：水印已嵌入 ✅ 位宽 512 bit（容量 12696 bit）耗时 6.26 秒）

# 提取（引用那张打好水印的图即可，不用记参数）
bwm.extract
（机器人回复：水印内容：版权所有 maimai 2026）
```

常用选项：

| 选项 | 说明 |
| --- | --- |
| `-b, --bits <number>` | 位宽（bit）。512 bit 约放 61 字节文字（≈20 个汉字），放长文本就调大（1024 / 2048），但图片必须够大 |
| `-p, --password <number>` | 图片密码，嵌入与提取必须一致（默认 1） |
| `-w, --watermarkPassword <number>` | 水印密码，嵌入与提取必须一致（默认 1） |

## ⚙️ 配置项

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `pythonPath` | `string` | `python` | python 可执行文件：PATH 里的名字或绝对路径 |
| `scriptPath` | `string` | `''` | `bwm_cli.py` 的路径，留空用插件自带的 |
| `timeout` | `number` | `120000` | 单次调用超时（毫秒）。打水印耗时和像素数成正比，大图请调大 |
| `maxSize` | `number` | `1600` | 打水印前把长边缩到该像素（0 = 不缩放）。缩图能大幅提速 |
| `bits` | `number` | `512` | 默认位宽，必须是 8 的倍数 |
| `candidateBits` | `number[]` | `[512, 1024, 256, 2048, 128]` | 提取时依次尝试的候选位宽 |
| `passwordImage` | `number` | `1` | 图片密码 |
| `passwordWatermark` | `number` | `1` | 水印密码 |
| `maxConcurrent` | `number` | `2` | 同时运行的 python 进程数上限（1 ~ 8） |
| `keepTemp` | `boolean` | `false` | 保留临时文件（调试用） |
| `authority` | `number` | `1` | 使用命令所需的最低权限等级 |
| `logoShape` | `string` | `64x64` | 图片水印的默认尺寸（宽x高） |
| `selfCheck` | `boolean` | `true` | 启动时自检 python 环境 |

## 🧠 它是怎么工作的

1. 命令把聊天里的图片下载下来（支持引用消息里的图、`base64://`、`data:` URL）
2. 写到 `data/blind-watermark/tmp` 下的临时文件，起一个 python 子进程跑 `python/bwm_cli.py`
3. `bwm_cli.py` 调用上游 `WaterMark`：图片 → YUV → 小波变换（DWT）→ 分块 DCT → SVD → 按 bit 修改奇异值 → 逆变换 → 输出 PNG
4. 结果图读回成 Buffer 发给用户，临时文件删掉

**为什么不怕压缩、缩放？** 水印写在低频（小波 LL 子带）的奇异值里，而且每个 bit 被循环嵌入到很多分块、三个通道上，提取时再投票平均，所以对攻击有天然冗余。

**为什么提取不用记长度？** 官方算法的文字模式里位宽要由使用者自己记住（字符串转 bit 时前导 0 会被吃掉）。本插件改成**定长包**：`[魔数 1B][长度 1B][校验 1B][UTF-8 正文][0 填充]`，总长固定为 `bits`；提取时按候选位宽各试一遍，魔数 + 校验都对才认。所以 `bwm.extract` 不需要任何参数。

**为什么输出 PNG？** JPG 是有损压缩，会把水印的细微改动抹掉（上游文档也强调水印图不要存成 JPG）。插件统一输出 PNG。

**能放多少字？** 容量 ≈ `(图宽/8) * (图高/8)` bit。512×512 的图约 4096 bit（默认只用 512 bit 保证鲁棒性）；图片太小会直接报「容量不足」。

**兼容官方 CLI**：`python/bwm_cli.py embed --mode str ...` / `extract --mode str --wm-shape N` 保留了上游 `str` 模式（此时位宽需要自己记），需要跟官方工具互通时用得上。

## 📂 目录结构

| 路径 | 说明 |
| --- | --- |
| `src/` | 插件源码（TypeScript） |
| `lib/` | 编译产物（`npm run build`） |
| `python/bwm_cli.py` | Python 桥：参数进、JSON 出 |
| `python/blind_watermark/` | 上游算法库源码（vendored，0.4.4，MIT） |
| `upstream/` | 上游仓库完整内容（示例、文档），仅供查阅，不参与打包 |
| `tests/` | 自测脚本 |
| `data/blind-watermark/tmp/` | 运行时的临时文件目录（在 Koishi 项目下） |

## 🧪 自测

```bash
npm run build
node tests/koishi-smoke.cjs   # 在真实 Koishi Context 里加载插件、检查命令注册
node tests/bridge-test.mjs    # 文字水印 / 图片水印往返 + 误报检查（需要 python 环境）
```

## ❓ 常见问题

**Q：日志说「找不到 python 可执行文件」？**
把配置里的 `pythonPath` 改成绝对路径，例如 `C:\Python311\python.exe` 或 `/usr/bin/python3`。

**Q：日志说缺少 numpy / opencv-python / PyWavelets？**
在**运行 Koishi 的那台机器上**执行 `pip install numpy opencv-python PyWavelets`（注意要用 Koishi 实际调用的那个 python）。

**Q：报「图片太小，装不下这个水印」？**
图片能装的 bit 数约为 `(宽/8)*(高/8)`。换更大的图，或者把 `--bits` 调小（比如 256）。

**Q：提取不到水印？**
依次检查：① 图片是不是被重新压成了 JPG / 被聊天软件「压缩原图」了；② 密码（`-p` / `-w`）和嵌入时是否一致；③ 裁剪是否太狠。上游文档给出的抗性实测包括缩放、裁剪、旋转、亮度、椒盐噪声、遮挡、截屏。

**Q：为什么一张图要跑好几秒？**
上游算法是逐像素的频域运算：1100×740 的图嵌入约 6 秒、提取约 4 秒，属于正常。想要快就调小 `maxSize`，并保持 `maxConcurrent` 别把 CPU 打满。

**Q：能自定义水印强度 / 鲁棒性吗？**
上游的 `d1/d2` 参数控制「鲁棒性 vs 画质」，本插件用默认值（36 / 20）。要调可以改 `python/bwm_cli.py` 里 `WaterMarkCore` 的初始化。

## 🙏 致谢与许可

- 算法与 Python 实现来自 [guofei9987/blind_watermark](https://github.com/guofei9987/blind_watermark)（MIT，作者 Guo Fei），源码以 vendored 形式放在 `python/blind_watermark/`，许可证见 `LICENSE.blind_watermark`。
- 本插件（TypeScript 封装、命令、服务、临时文件与并发管理）同样以 MIT 发布。
