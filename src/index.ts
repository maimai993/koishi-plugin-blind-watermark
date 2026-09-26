import { Context, Schema, Session, h } from 'koishi'
import { BlindWatermarkService } from './service'

export const name = 'blind-watermark'

/** http 服务用于下载聊天里的图片，缺失时命令会给出提示 */
export const inject = { required: [], optional: ['http'] }

export interface Config {
  pythonPath: string
  scriptPath: string
  timeout: number
  maxSize: number
  bits: number
  candidateBits: number[]
  passwordImage: number
  passwordWatermark: number
  maxConcurrent: number
  keepTemp: boolean
  authority: number
  logoShape: string
  selfCheck: boolean
  promptTimeout: number
}

export const Config: Schema<Config> = Schema.object({
  pythonPath: Schema.string().default('python')
    .description('python 可执行文件：PATH 里的名字（python / python3）或绝对路径。'),
  scriptPath: Schema.string().default('')
    .description('bwm_cli.py 的路径，留空使用插件自带的 python/bwm_cli.py。'),
  timeout: Schema.natural().default(120000).min(5000)
    .description('单次调用超时（毫秒）。打水印耗时和像素数成正比，大图请调大。'),
  maxSize: Schema.natural().default(1600).min(0)
    .description('打水印前把图片长边缩到该像素（0 = 不缩放）。缩图能大幅提速，代价是画质略降。'),
  bits: Schema.natural().default(512).min(8)
    .description('默认位宽（bit，必须是 8 的倍数）：512 bit 约可容纳 61 字节文字（约 20 个汉字）。文字更长时会自动提高位宽。'),
  candidateBits: Schema.array(Schema.natural()).default([512, 1024, 256, 2048, 128])
    .description('提取时依次尝试的候选位宽，命中魔数 + 校验即返回。'),
  passwordImage: Schema.natural().default(1)
    .description('图片密码（打水印与提取必须一致）。'),
  passwordWatermark: Schema.natural().default(1)
    .description('水印密码（打水印与提取必须一致）。'),
  maxConcurrent: Schema.natural().default(2).min(1).max(8)
    .description('同时运行的 python 进程数上限（打水印很吃 CPU，别调太大）。'),
  keepTemp: Schema.boolean().default(false)
    .description('保留临时文件（调试用）。默认用完即删。'),
  authority: Schema.natural().default(1)
    .description('使用命令所需的最低权限等级。'),
  logoShape: Schema.string().default('64x64')
    .description('图片水印的默认尺寸（宽x高），提取时没有提供水印图就用它。'),
  selfCheck: Schema.boolean().default(true)
    .description('启动时自检 python 环境（缺依赖会在日志里给出 pip 安装提示）。'),
  promptTimeout: Schema.natural().default(60000).min(5000)
    .description('交互式追问（请发送水印文字 / 图片）的等待时间（毫秒）。'),
})

declare module 'koishi' {
  interface Context {
    bwm: BlindWatermarkService
  }
}

/** 一条消息里我们关心的东西：纯文本 + 图片地址 */
export interface MessageParts {
  text: string
  images: string[]
}

/** 把消息元素（或元素字符串）拆成「文本 + 图片」，@、表情、引用等一律忽略 */
export function parseElements(input: any, parts: MessageParts = { text: '', images: [] }): MessageParts {
  if (!input) return parts
  if (typeof input === 'string') {
    try {
      return parseElements(h.parse(input), parts)
    } catch {
      parts.text += input
      return parts
    }
  }
  if (Array.isArray(input)) {
    for (const item of input) parseElements(item, parts)
    return parts
  }
  if (typeof input !== 'object') return parts

  const type = input.type
  if (type === 'img' || type === 'image') {
    const src = input.attrs?.src || input.attrs?.url || input.attrs?.file || input.data?.url
    if (typeof src === 'string' && src) parts.images.push(src)
    return parts
  }
  if (type === 'text') {
    const value = typeof input.attrs?.content === 'string' ? input.attrs.content
      : typeof input.data === 'string' ? input.data : ''
    if (value) parts.text += value
    return parts
  }
  // 其它元素只在有子元素时才往里找
  if (input.children) parseElements(input.children, parts)
  return parts
}

/** 把命令本身从文本开头去掉（/bwm.embed 麦麦 -> 麦麦） */
export function stripCommand(text: string, session?: Session): string {
  let out = String(text || '')
  const nickname: any = (session as any)?.app?.koishi?.config?.nickname
  if (Array.isArray(nickname)) {
    for (const item of nickname) {
      if (typeof item !== 'string' || !item) continue
      if (out.startsWith(item)) out = out.slice(item.length).replace(/^[,，:：\s]+/, '')
    }
  }
  out = out.replace(/^\s*[\/／!！.。]\s*(?:bwm|盲水印)(?:\.[a-zA-Z]+)*\s*/i, '')
  return out.trim()
}

/** 去掉元素标记（<img src="..."/>）后的纯文本，用于兜底 */
export function cleanText(value: any): string {
  return String(value == null ? '' : value).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
}

/** 读取一条消息（Session 或 prompt 返回的原始内容） */
export function readMessage(input: any, session?: Session): MessageParts {
  const parts = parseElements(input)
  parts.text = stripCommand(parts.text, session)
  return parts
}

/** 引用消息里的图片 */
export function quotedImages(session: Session): string[] {
  const quote: any = (session as any).quote || (session.event as any)?.quote
  if (!quote) return []
  return parseElements(quote.content ?? quote.elements ?? quote.message?.content ?? quote).images
}

const CANCEL_RE = /^(取消|算了|不用了|不打了|cancel|quit|exit)$/i

/** 等用户下一条消息；超时/无 prompt 能力时返回 null */
async function waitForInput(session: Session, timeout: number): Promise<string | null> {
  const prompt = (session as any).prompt
  if (typeof prompt !== 'function') return null
  try {
    const answer = await prompt.call(session, timeout)
    if (answer === undefined || answer === null || answer === '') return null
    return typeof answer === 'string' ? answer : String(answer)
  } catch {
    return null
  }
}

async function downloadImage(ctx: Context, src: string): Promise<Buffer> {
  if (src.startsWith('base64://')) return Buffer.from(src.slice('base64://'.length), 'base64')
  if (src.startsWith('data:')) {
    const index = src.indexOf(',')
    const meta = src.slice(5, index)
    const payload = src.slice(index + 1)
    return Buffer.from(payload, /;base64/i.test(meta) ? 'base64' : 'utf8')
  }
  const http: any = (ctx as any).http
  if (!http) throw new Error('缺少 http 服务（请在 Koishi 里启用 @koishijs/plugin-http）')
  const data = await http.get(src, { responseType: 'arraybuffer' })
  return Buffer.isBuffer(data) ? data : Buffer.from(data)
}

/** 命令 option 的值可能是 true（只写了 -p 没写数值），统一转成数字 */
export function toNumber(value: any, fallback?: number): number | undefined {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function describeError(result: any): string {
  const code = result?.code
  if (code === 'capacity') return '这张图装不下这个水印：' + (result.message || '') + '\n换张更大的图，或把位宽调小。'
  if (code === 'too-long') return result.message || '水印内容太长'
  if (code === 'no-python') return (result.message || '找不到 python') + '\n' + (result.hint || '')
  if (code === 'missing-deps') return '服务器缺少 Python 依赖：' + (result.message || '') + '\n请执行：pip install numpy opencv-python PyWavelets'
  if (code === 'timeout') return result.message || '调用超时'
  if (code === 'bad-image') return result.message || '图片无法解析'
  return (result?.message || '未知错误') + (result?.hint ? '\n' + result.hint : '')
}

/** 文字需要多少 bit（+3 字节包头），并按候选位宽挑一个装得下的 */
export function pickBits(text: string, configured: number, candidates: number[]): number {
  const needed = (Buffer.byteLength(text, 'utf8') + 3) * 8
  if (needed <= configured) return configured
  const sorted = candidates.slice().sort((a, b) => a - b)
  const fit = sorted.find((bits) => bits >= needed)
  return Math.ceil((fit || needed) / 8) * 8
}

export function apply(ctx: Context, config: Config) {
  const service = new BlindWatermarkService(ctx, {
    pythonPath: config.pythonPath,
    timeout: config.timeout,
    maxSize: config.maxSize,
    bits: config.bits,
    candidateBits: config.candidateBits,
    passwordImage: config.passwordImage,
    passwordWatermark: config.passwordWatermark,
    maxConcurrent: config.maxConcurrent,
    keepTemp: config.keepTemp,
  })
  if (config.scriptPath) service.setScript(config.scriptPath)
  ctx.set('bwm', service)

  if (config.selfCheck) {
    ctx.on('ready', async () => {
      const result = await service.check()
      if (result.ok) {
        ctx.logger('blind-watermark').info(
          '盲水印环境就绪：python %s / blind_watermark %s / numpy %s / opencv %s / pywt %s',
          result.python, result.blindWatermark, result.numpy, result.opencv, result.pywt,
        )
      } else {
        ctx.logger('blind-watermark').warn('盲水印环境不可用：' + describeError(result))
      }
    })
  }

  /** 追问图片：返回图片 URL 列表（没有就返回空数组） */
  async function askImage(session: Session, question = '请发送（或引用）要处理的图片（' + Math.round(config.promptTimeout / 1000) + ' 秒内）'): Promise<string[]> {
    await session.send(question)
    const answer = await waitForInput(session, config.promptTimeout)
    if (answer === null) return []
    const parts = readMessage(answer, session)
    if (CANCEL_RE.test(parts.text)) return []
    return parts.images
  }

  const root = ctx.command('bwm', '盲水印：往图片里嵌入 / 提取看不见的水印', { authority: config.authority })
    .alias('盲水印')

  root.subcommand('.embed [text:text]', '给图片打上文字盲水印')
    .alias('bwm.text')
    .usage('不带参数也没关系：机器人会先问你要水印文字，再问你要图片。也可以把文字和图片一起发，或先引用图片再发命令。')
    .example('bwm.embed 版权所有 maimai 2026')
    .option('bits', '-b <bits:number> 位宽，默认 ' + config.bits + '（文字更长时自动提高）')
    .option('password', '-p <password:number> 图片密码（默认 ' + config.passwordImage + '）')
    .option('watermarkPassword', '-w <password:number> 水印密码（默认 ' + config.passwordWatermark + '）')
    .action(async ({ session, options }, text) => {
      const parts = readMessage(session.event?.message?.content ?? session.event?.message, session)
      let watermark = parts.text || cleanText(text)
      const images = parts.images.slice()

      // 没给文字 -> 追问
      if (!watermark) {
        if (!images.length && !quotedImages(session).length) await session.send('好，先告诉我水印文字吧。')
        else await session.send('好，先告诉我水印文字吧（已收到图片）。')
        const answer = await waitForInput(session, config.promptTimeout)
        if (answer === null) return '等太久啦，已取消。想继续就再发一次 bwm.embed。'
        const parsed = readMessage(answer, session)
        watermark = parsed.text || cleanText(answer)
        images.push(...parsed.images)
        if (CANCEL_RE.test(watermark)) return '已取消。'
      }

      // 没给图片 -> 追问
      let url = quotedImages(session)[0] || images[0]
      if (!url) {
        const more = await askImage(session)
        url = more[0]
      }
      if (!url) return '没有收到图片，已取消。把水印文字和图片一起发给我也行：bwm.embed 水印文字 + 图片。'

      let image: Buffer
      try {
        image = await downloadImage(ctx, url)
      } catch (error: any) {
        return '下载图片失败：' + (error?.message || error)
      }

      const configuredBits = toNumber(options.bits) || config.bits
      const bits = pickBits(watermark, configuredBits, config.candidateBits)
      const result = await service.embedText(image, watermark, {
        bits,
        passwordImage: toNumber(options.password, config.passwordImage),
        passwordWatermark: toNumber(options.watermarkPassword, config.passwordWatermark),
      })
      if (!result.ok || !result.buffer) return describeError(result)

      const lines = [
        '水印已嵌入 ✅',
        '内容：' + watermark,
        '位宽 ' + result.bits + ' bit（图片容量 ' + result.capacity + ' bit）' + (bits !== configuredBits ? '（文字较长，已自动提高位宽）' : ''),
        '耗时 ' + result.elapsed + ' 秒' + (result.scaledFrom ? '（已从 ' + result.scaledFrom.join('x') + ' 缩放）' : ''),
        '提取：引用这张图发 bwm.extract 即可',
      ]
      await session.send(lines.join('\n'))
      return h.image(result.buffer, 'image/png')
    })

  root.subcommand('.extract [bits:number]', '从图片里提取文字盲水印')
    .alias('bwm.read')
    .usage('引用打过水印的图片，或在同一条消息里带上图片；不带图片时会追问。默认自动尝试常见位宽。')
    .example('bwm.extract')
    .option('password', '-p <password:number> 图片密码（默认 ' + config.passwordImage + '）')
    .option('watermarkPassword', '-w <password:number> 水印密码（默认 ' + config.passwordWatermark + '）')
    .action(async ({ session, options }, bits) => {
      const parts = readMessage(session.event?.message?.content ?? session.event?.message, session)
      let url = quotedImages(session)[0] || parts.images[0]
      if (!url) url = (await askImage(session, '请发送（或引用）要提取水印的图片'))[0]
      if (!url) return '没有收到图片，已取消。'
      let image: Buffer
      try {
        image = await downloadImage(ctx, url)
      } catch (error: any) {
        return '下载图片失败：' + (error?.message || error)
      }
      const result = await service.extractText(image, {
        bits: bits ? [bits] : config.candidateBits,
        passwordImage: toNumber(options.password, config.passwordImage),
        passwordWatermark: toNumber(options.watermarkPassword, config.passwordWatermark),
      })
      if (!result.ok) return describeError(result)
      if (!result.found) return result.message || '没有提取到水印（可能没打过水印、密码不对，或图片被压坏了）。'
      return '水印内容：' + result.text + '\n（位宽 ' + result.bits + ' bit，耗时 ' + result.elapsed + ' 秒）'
    })

  root.subcommand('.embed.logo', '给图片打上图片水印（用另一张图当水印）')
    .alias('bwm.logo')
    .usage('引用载体图片 + 把作为水印的图片一起发出来；缺哪个机器人会追问。')
    .option('password', '-p <password:number> 图片密码（默认 ' + config.passwordImage + '）')
    .option('watermarkPassword', '-w <password:number> 水印密码（默认 ' + config.passwordWatermark + '）')
    .action(async ({ session, options }) => {
      const parts = readMessage(session.event?.message?.content ?? session.event?.message, session)
      const quoted = quotedImages(session)
      let carrierUrl = quoted[0] || (parts.images.length > 1 ? parts.images[0] : '')
      let logoUrl = quoted[0] ? parts.images[0] : parts.images[1]

      if (!carrierUrl) {
        const got = await askImage(session, '请发送（或引用）**载体图片**（要被打水印的那张）')
        carrierUrl = got[0]
        if (!logoUrl) logoUrl = got[1]
      }
      if (!carrierUrl) return '没有收到载体图片，已取消。'
      if (!logoUrl) {
        const got = await askImage(session, '再发送**水印图片**（建议黑底白字的 64x64 小图）')
        logoUrl = got[0]
      }
      if (!logoUrl) return '没有收到水印图片，已取消。'

      let carrierImage: Buffer
      let logoImage: Buffer
      try {
        carrierImage = await downloadImage(ctx, carrierUrl)
        logoImage = await downloadImage(ctx, logoUrl)
      } catch (error: any) {
        return '下载图片失败：' + (error?.message || error)
      }
      const result = await service.embedLogo(carrierImage, logoImage, {
        passwordImage: toNumber(options.password, config.passwordImage),
        passwordWatermark: toNumber(options.watermarkPassword, config.passwordWatermark),
      })
      if (!result.ok || !result.buffer) return describeError(result)
      await session.send('图片水印已嵌入 ✅ 位宽 ' + result.bits + ' bit（容量 ' + result.capacity + ' bit），耗时 ' + result.elapsed + ' 秒\n提取：引用这张图 + 把同一张水印图发出来 → bwm.extract.logo')
      return h.image(result.buffer, 'image/png')
    })

  root.subcommand('.extract.logo [shape:string]', '提取图片水印')
    .alias('bwm.readLogo')
    .usage('引用打过水印的图片；把原水印图一起发出来最稳，也可以直接给尺寸（默认 ' + config.logoShape + '）。')
    .example('bwm.extract.logo 64x64')
    .option('password', '-p <password:number> 图片密码（默认 ' + config.passwordImage + '）')
    .option('watermarkPassword', '-w <password:number> 水印密码（默认 ' + config.passwordWatermark + '）')
    .action(async ({ session, options }, shape) => {
      const parts = readMessage(session.event?.message?.content ?? session.event?.message, session)
      const quoted = quotedImages(session)
      let carrierUrl = quoted[0] || parts.images[0]
      let logoUrl = quoted[0] ? parts.images[0] : parts.images[1]
      if (!carrierUrl) {
        const got = await askImage(session, '请发送（或引用）打过图片水印的图片')
        carrierUrl = got[0]
        if (!logoUrl) logoUrl = got[1]
      }
      if (!carrierUrl) return '没有收到图片，已取消。'

      let carrierImage: Buffer
      let logoImage: Buffer | undefined
      try {
        carrierImage = await downloadImage(ctx, carrierUrl)
        if (logoUrl) logoImage = await downloadImage(ctx, logoUrl)
      } catch (error: any) {
        return '下载图片失败：' + (error?.message || error)
      }
      const result = await service.extractLogo(carrierImage, {
        logo: logoImage,
        shape: shape || config.logoShape,
        passwordImage: toNumber(options.password, config.passwordImage),
        passwordWatermark: toNumber(options.watermarkPassword, config.passwordWatermark),
      })
      if (!result.ok || !result.buffer) return describeError(result)
      await session.send('水印已提取 ✅（' + (result.wmShape || []).join('x') + '，耗时 ' + result.elapsed + ' 秒）')
      return h.image(result.buffer, 'image/png')
    })

  root.subcommand('.info', '盲水印环境自检')
    .action(async () => {
      const result = await service.info(true)
      if (!result.ok) return describeError(result)
      return [
        'python ' + result.python,
        'blind_watermark ' + result.blindWatermark,
        'numpy ' + result.numpy,
        'opencv ' + result.opencv,
        'pywt ' + result.pywt,
        '脚本 ' + service.script,
      ].join('\n')
    })
}
