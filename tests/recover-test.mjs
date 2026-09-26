/**
 * 裁剪复原测试（服务层）：
 *   1. 打一张水印图，再用 python 裁出几种「稍微裁剪」的版本
 *   2. 直接提取 -> 应该失败（水印按原图尺寸的固定网格嵌入，裁剪就错位）
 *   3. 传原图（--original）复原画布 -> 应该成功
 *   4. 只给原图尺寸 + 裁剪位置（--canvas/--offset）-> 应该成功
 *   5. 裁剪 + 缩放 0.7（--scale-search）-> 应该成功
 *
 *   node tests/recover-test.mjs
 */
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { BlindWatermarkService } from '../lib/service.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = join(root, '_tmp_test')
const py = (code) => execFileSync(process.env.PYTHON || 'python', ['-c', code], { encoding: 'utf8' })

const ctx = { baseDir: root, logger: () => ({ info() {}, warn() {}, error() {}, debug() {} }) }
const service = new BlindWatermarkService(ctx, {
  pythonPath: process.env.PYTHON || 'python',
  timeout: 300000,
  maxSize: 0,
  bits: 512,
  candidateBits: [512],
  passwordImage: 1,
  passwordWatermark: 1,
  maxConcurrent: 2,
  keepTemp: false,
})

let failed = 0
const check = (name, ok, detail = '') => {
  if (ok) console.log('  ✔ ' + name + (detail ? '  ' + detail : ''))
  else { failed++; console.log('  ✘ ' + name + (detail ? '  ' + detail : '')) }
}

const TEXT = 'koishi 裁剪复原测试'

await rm(work, { recursive: true, force: true })
await mkdir(work, { recursive: true })

console.log('1) 准备：原图 + 打水印 + 三种裁剪')
const carrier = await readFile(join(root, 'upstream', 'examples', 'pic', 'ori_img.jpeg'))
await writeFile(join(work, 'original.png'), carrier)
const embedded = await service.embedText(carrier, TEXT)
check('嵌入成功', embedded.ok && !!embedded.buffer)
await writeFile(join(work, 'embedded.png'), embedded.buffer)

py([
  'import cv2',
  "img = cv2.imread(r'" + join(work, 'embedded.png') + "')",
  "cv2.imwrite(r'" + join(work, 'crop_left40.png') + "', img[:, 40:])",
  "cv2.imwrite(r'" + join(work, 'crop_mid.png') + "', img[100:700, 200:900])",
  "cv2.imwrite(r'" + join(work, 'crop_scaled.png') + "', cv2.resize(img[30:, 50:], None, fx=0.7, fy=0.7))",
  'print(img.shape)',
].join('\n'))
const cropLeft = await readFile(join(work, 'crop_left40.png'))
const cropMid = await readFile(join(work, 'crop_mid.png'))
const cropScaled = await readFile(join(work, 'crop_scaled.png'))

console.log('2) 直接提取裁剪图（预期失败）')
const direct = await service.extractText(cropLeft, { bits: [512] })
check('裁剪后直接提取失败', direct.ok && direct.found === false)

console.log('3) 传原图复原后提取')
const withOriginal = await service.extractText(cropLeft, { bits: [512], original: carrier })
check('左裁 40：复原后提取成功', withOriginal.ok && withOriginal.found === true && withOriginal.text === TEXT,
  JSON.stringify(withOriginal.recovered))
const mid = await service.extractText(cropMid, { bits: [512], original: carrier })
check('中间取块：复原后提取成功', mid.ok && mid.found === true && mid.text === TEXT,
  JSON.stringify(mid.recovered))

console.log('4) 只给原图尺寸 + 裁剪位置')
const byCanvas = await service.extractText(cropLeft, { bits: [512], canvas: '738x1108', offset: '40,0' })
check('canvas + offset 复原成功', byCanvas.ok && byCanvas.found === true && byCanvas.text === TEXT,
  JSON.stringify(byCanvas.recovered))

console.log('5) 裁剪 + 缩放 0.7')
const scaled = await service.extractText(cropScaled, { bits: [512], original: carrier, scaleSearch: true })
check('搜缩放后提取成功', scaled.ok && scaled.found === true && scaled.text === TEXT,
  JSON.stringify(scaled.recovered))

console.log('6) locate：定位裁剪块')
const located = await service.locate(cropMid, carrier)
check('定位成功', located.ok === true && located.x === 200 && located.y === 100, JSON.stringify(located))

console.log(failed ? '\n失败 ' + failed + ' 项' : '\n裁剪复原测试全部通过 ✅')
process.exit(failed ? 1 : 0)
