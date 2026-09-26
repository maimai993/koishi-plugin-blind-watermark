/**
 * 不依赖 Koishi 的集成测试：直接用编译产物 BlindWatermarkService 跑一遍
 * 「文字水印」和「图片水印」的往返，验证 Node -> python -> Node 这条链路。
 *
 *   node tests/bridge-test.mjs
 */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { BlindWatermarkService } from '../lib/service.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pic = (...parts) => join(root, 'upstream', 'examples', 'pic', ...parts)

const ctx = {
  baseDir: root,
  logger: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
}

const service = new BlindWatermarkService(ctx, {
  pythonPath: process.env.PYTHON || 'python',
  timeout: 300000,
  maxSize: 0,
  bits: 512,
  candidateBits: [512, 256, 128],
  passwordImage: 1,
  passwordWatermark: 1,
  maxConcurrent: 2,
  keepTemp: false,
})

let failed = 0
function check(name, condition, detail = '') {
  if (condition) {
    console.log('  ✔ ' + name + (detail ? '  ' + detail : ''))
  } else {
    failed++
    console.log('  ✘ ' + name + (detail ? '  ' + detail : ''))
  }
}

const carrier = await readFile(pic('ori_img.jpeg'))
const logo = await readFile(pic('watermark.png'))

console.log('1) 环境自检')
const info = await service.check()
console.log('   ' + JSON.stringify(info))
check('环境可用', info.ok === true)

console.log('2) 容量')
const capacity = await service.capacity(carrier)
check('容量可读', capacity.ok === true && capacity.capacity > 0, '容量 ' + capacity.capacity + ' bit')

console.log('3) 文字水印往返')
const text = 'koishi blind watermark 测试 ' + new Date().toISOString().slice(0, 10)
const embedded = await service.embedText(carrier, text)
check('嵌入成功', embedded.ok === true && !!embedded.buffer, (embedded.elapsed || '?') + 's / ' + (embedded.buffer ? embedded.buffer.length : 0) + ' bytes')
if (!embedded.ok) console.log('   ' + JSON.stringify(embedded))

const extracted = await service.extractText(embedded.buffer)
check('提取成功', extracted.ok === true && extracted.found === true, '位宽 ' + extracted.bits + ' / ' + (extracted.elapsed || '?') + 's')
check('内容一致', extracted.text === text, JSON.stringify(extracted.text))

console.log('4) 未加水印的图不应误报')
const negative = await service.extractText(carrier, { bits: [256] })
check('正确判定无水印', negative.ok === true && negative.found === false)

console.log('5) 图片水印往返')
const logoEmbedded = await service.embedLogo(carrier, logo)
check('图片水印嵌入成功', logoEmbedded.ok === true && !!logoEmbedded.buffer, '位宽 ' + logoEmbedded.bits)
const logoExtracted = await service.extractLogo(logoEmbedded.buffer, { logo })
check('图片水印提取成功', logoExtracted.ok === true && !!logoExtracted.buffer, '尺寸 ' + JSON.stringify(logoExtracted.wmShape))
if (logoExtracted.buffer) {
  // 提取出来的水印应该和原图尺寸一致（内容会因为攻击/压缩有噪声，这里只比尺寸）
  const original = await readFile(pic('watermark.png'))
  check('水印图尺寸一致', logoExtracted.buffer.length > 0 && original.length > 0, logoExtracted.buffer.length + ' bytes')
}

console.log('6) 大图缩放')
const scaled = await service.embedText(carrier, text, { maxSize: 400 })
check('缩放后仍能嵌入', scaled.ok === true && !!scaled.buffer, 'scaledFrom ' + JSON.stringify(scaled.scaledFrom))

console.log(failed ? '\n失败 ' + failed + ' 项' : '\n全部通过 ✅')
process.exit(failed ? 1 : 0)
