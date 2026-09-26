import { promises as fs } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { isAbsolute, join, resolve } from 'node:path'
import { Context } from 'koishi'
import { BridgeResult, PythonBridge } from './python'

export interface ServiceOptions {
  /** python 可执行文件 */
  pythonPath: string
  /** 单次调用超时（毫秒） */
  timeout: number
  /** 打水印前把长边限制到该像素（0 = 不缩放） */
  maxSize: number
  /** 默认位宽（bit），必须是 8 的倍数 */
  bits: number
  /** 提取时依次尝试的候选位宽 */
  candidateBits: number[]
  passwordImage: number
  passwordWatermark: number
  maxConcurrent: number
  keepTemp: boolean
}

export interface TextEmbedResult extends BridgeResult {
  buffer?: Buffer
}

export interface TextExtractResult extends BridgeResult {
  text?: string
  found?: boolean
}

export interface LogoEmbedResult extends BridgeResult {
  buffer?: Buffer
  bits?: number
}

export interface LogoExtractResult extends BridgeResult {
  buffer?: Buffer
}

/** bwm_cli.py 相对于本包的路径：lib/xxx.js -> ../python/bwm_cli.py */
export function defaultScriptPath(): string {
  return join(__dirname, '..', 'python', 'bwm_cli.py')
}

/** 按魔数猜一个扩展名，交给 cv2 的文件名只是给个名字，内容才是关键 */
function guessExt(buffer: Buffer): string {
  if (buffer.length > 12 && buffer[0] === 0x89 && buffer[1] === 0x50) return 'png'
  if (buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8) return 'jpg'
  if (buffer.length > 4 && buffer.toString('ascii', 0, 3) === 'GIF') return 'gif'
  if (buffer.length > 12 && buffer.toString('ascii', 8, 12) === 'WEBP') return 'webp'
  if (buffer.length > 2 && buffer.toString('ascii', 0, 2) === 'BM') return 'bmp'
  return 'png'
}

/**
 * 盲水印服务（ctx.bwm）。
 *
 * 对上层暴露「Buffer 进、Buffer 出」的接口，内部负责：
 *   - 把图片写到临时文件、调用 python、把结果读回来、清理临时文件
 *   - 并发控制（python 打水印很吃 CPU，默认最多同时 2 个）
 *   - 环境自检缓存（info 只跑一次）
 */
export class BlindWatermarkService {
  private bridge: PythonBridge
  private directory: string
  private running = 0
  private waiters: Array<() => void> = []
  private infoCache: BridgeResult | null = null
  private pruned = false

  constructor(private ctx: Context, private options: ServiceOptions) {
    this.bridge = new PythonBridge({
      python: options.pythonPath,
      script: defaultScriptPath(),
      timeout: options.timeout,
    })
    this.directory = join(ctx.baseDir, 'data', 'blind-watermark', 'tmp')
  }

  /** 打水印时 python 的调用超时（毫秒） */
  get timeout() {
    return this.options.timeout
  }

  /** bwm_cli.py 的绝对路径（配置里也可以覆盖，见 index.ts） */
  get script() {
    return this.bridge.script
  }

  get directory_() {
    return this.directory
  }

  setScript(script: string) {
    this.bridge = new PythonBridge({ python: this.options.pythonPath, script, timeout: this.options.timeout })
  }

  /** 环境自检：python / numpy / opencv / pywt / blind_watermark 版本 */
  async info(force = false): Promise<BridgeResult> {
    if (this.infoCache && !force) return this.infoCache
    const result = await this.bridge.run(['info'])
    if (result.ok) this.infoCache = result
    return result
  }

  /** 检查环境是否可用，不可用时返回带 hint 的结果 */
  async check(): Promise<BridgeResult> {
    const result = await this.info(true)
    if (result.ok) return result
    if (result.code === 'no-python') {
      return Object.assign({}, result, {
        hint: (result.hint || '') + '（配置项 pythonPath 默认是 "python"）',
      })
    }
    if (result.code === 'missing-deps') {
      return Object.assign({}, result, {
        hint: '在服务器上执行：pip install numpy opencv-python PyWavelets（' + (result.hint || '') + '）',
      })
    }
    return result
  }

  /** 图片能装下多少 bit 的水印 */
  async capacity(image: Buffer): Promise<BridgeResult> {
    const input = await this.writeTemp(image)
    try {
      return await this.run(['capacity', '--img', input])
    } finally {
      await this.remove(input)
    }
  }

  /** 文字水印：把 text 打进 image，返回打好水印的图片 */
  async embedText(image: Buffer, text: string, options: { bits?: number; passwordImage?: number; passwordWatermark?: number; maxSize?: number } = {}): Promise<TextEmbedResult> {
    const bits = options.bits ?? this.options.bits
    const input = await this.writeTemp(image)
    const output = await this.tempPath('png')
    try {
      const args = [
        'embed',
        '--img', input,
        '--out', output,
        '--text', text,
        '--bits', String(bits),
        '--password-image', String(options.passwordImage ?? this.options.passwordImage),
        '--password-watermark', String(options.passwordWatermark ?? this.options.passwordWatermark),
      ]
      const maxSize = options.maxSize ?? this.options.maxSize
      if (maxSize > 0) args.push('--max-size', String(maxSize))
      const result = await this.run(args) as TextEmbedResult
      if (result.ok) result.buffer = await fs.readFile(output)
      return result
    } finally {
      await this.remove(input, output)
    }
  }

  /** 文字水印提取：自动按候选位宽尝试，返回 result.text */
  async extractText(image: Buffer, options: { bits?: number[] | string; passwordImage?: number; passwordWatermark?: number } = {}): Promise<TextExtractResult> {
    const bits = options.bits ?? this.options.candidateBits
    const input = await this.writeTemp(image)
    try {
      const args = [
        'extract',
        '--img', input,
        '--password-image', String(options.passwordImage ?? this.options.passwordImage),
        '--password-watermark', String(options.passwordWatermark ?? this.options.passwordWatermark),
      ]
      const list = Array.isArray(bits) ? bits : String(bits)
      args.push('--bits', Array.isArray(list) ? list.join(',') : list)
      return await this.run(args) as TextExtractResult
    } finally {
      await this.remove(input)
    }
  }

  /** 图片水印：把 logo 打进载体图 */
  async embedLogo(carrier: Buffer, logo: Buffer, options: { passwordImage?: number; passwordWatermark?: number; maxSize?: number } = {}): Promise<LogoEmbedResult> {
    const input = await this.writeTemp(carrier)
    const logoPath = await this.writeTemp(logo)
    const output = await this.tempPath('png')
    try {
      const args = [
        'embed',
        '--img', input,
        '--out', output,
        '--logo', logoPath,
        '--password-image', String(options.passwordImage ?? this.options.passwordImage),
        '--password-watermark', String(options.passwordWatermark ?? this.options.passwordWatermark),
      ]
      const maxSize = options.maxSize ?? this.options.maxSize
      if (maxSize > 0) args.push('--max-size', String(maxSize))
      const result = await this.run(args) as LogoEmbedResult
      if (result.ok) result.buffer = await fs.readFile(output)
      return result
    } finally {
      await this.remove(input, logoPath, output)
    }
  }

  /** 图片水印提取：给出 logo 图（或宽x高）即可 */
  async extractLogo(carrier: Buffer, options: { logo?: Buffer; shape?: string; passwordImage?: number; passwordWatermark?: number } = {}): Promise<LogoExtractResult> {
    const input = await this.writeTemp(carrier)
    const logoPath = options.logo ? await this.writeTemp(options.logo) : ''
    const output = await this.tempPath('png')
    try {
      const args = [
        'extract',
        '--img', input,
        '--out-wm', output,
        '--password-image', String(options.passwordImage ?? this.options.passwordImage),
        '--password-watermark', String(options.passwordWatermark ?? this.options.passwordWatermark),
      ]
      if (logoPath) args.push('--logo', logoPath)
      else if (options.shape) args.push('--wm-shape', options.shape)
      const result = await this.run(args) as LogoExtractResult
      if (result.ok) result.buffer = await fs.readFile(output)
      return result
    } finally {
      await this.remove(input, logoPath, output)
    }
  }

  /** 跑一次 python（带并发闸门 + 清理旧临时文件） */
  private async run(args: string[]): Promise<BridgeResult> {
    await this.acquire()
    try {
      await this.pruneOnce()
      return await this.bridge.run(args)
    } finally {
      this.release()
    }
  }

  private async acquire() {
    const max = Math.max(1, this.options.maxConcurrent || 1)
    while (this.running >= max) await new Promise<void>((resolve) => this.waiters.push(resolve))
    this.running++
  }

  private release() {
    this.running--
    const next = this.waiters.shift()
    if (next) next()
  }

  /** 第一次调用时清掉 2 小时前的临时文件（进程被杀时可能留下残渣） */
  private async pruneOnce() {
    if (this.pruned || this.options.keepTemp) return
    this.pruned = true
    try {
      await fs.mkdir(this.directory, { recursive: true })
      const files = await fs.readdir(this.directory)
      const deadline = Date.now() - 2 * 60 * 60 * 1000
      for (const file of files) {
        const target = join(this.directory, file)
        const stat = await fs.stat(target).catch(() => null)
        if (stat && stat.mtimeMs < deadline) await fs.unlink(target).catch(() => null)
      }
    } catch { /* 忽略 */ }
  }

  private async tempPath(ext: string): Promise<string> {
    await fs.mkdir(this.directory, { recursive: true })
    return join(this.directory, randomUUID() + '.' + ext)
  }

  private async writeTemp(buffer: Buffer, ext = guessExt(buffer)): Promise<string> {
    const target = await this.tempPath(ext)
    await fs.writeFile(target, buffer)
    return target
  }

  private async remove(...files: string[]) {
    if (this.options.keepTemp) return
    for (const file of files) {
      if (!file) continue
      await fs.unlink(file).catch(() => null)
    }
  }
}

/** 把用户填的路径转成绝对路径（相对路径按 baseDir 解析） */
export function resolveFrom(baseDir: string, target: string): string {
  if (!target) return target
  return isAbsolute(target) ? target : resolve(baseDir, target)
}
