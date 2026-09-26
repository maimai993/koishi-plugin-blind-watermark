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
    .description('默认位宽（bit，必须是 8 的倍数）：512 bit 约可容纳 61 字节文字（约 20 个汉字）。'),
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
})

declare module 'koishi' {
  interface Context {
    bwm: BlindWatermarkService
  }
}

/** 从一段消息元素里收集图片地址 */
function collectUrls(input: any, output: string[]) {
  if (!input) return
  if (typeof input === 'string') {
    try {
      collectUrls(h.parse(input), output)
    } catch { /* 解析不了就算了 */ }
    return
  }
  if (Array.isArray(input)) {
    for (const item of input) collectUrls(item, output)
    return
  }
  if (typeof input !== 'object') return
  if (input.type === 'img' || input.type === 'image') {
    const src = input.attrs?.src || input.attrs?.url || input.data?.url
    if (typeof src === 'string' && src) output.push(src)
    return
  }
  if (input.content) collectUrls(input.content, output)
  if (input.elements) collectUrls(input.elements, output)
}

export interface ImageSource {
  /** 引用消息里的图片（消息里没有图时也会兜底用本消息的图） */
  carrier: string[]
  /** 本消息直接带的图片 */
  attached: string[]
}

/** 拆出「引用的图」与「本消息带的图」 */
export function splitImages(session: Session): ImageSource {
  const attached: string[] = []
  const carrier: string[] = []
  const event: any = session.event || {}
  collectUrls(event.message?.content ?? event.message?.elements ?? event.message, attached)
  const quote: any = (session as any).quote
  if (quote) collectUrls(quote.content ?? quote.elements ?? quote, carrier)
  if (!carrier.length && attached.length > 1) carrier.push(attached.shift() as string)
  if (!carrier.length && attached.length === 1 && (session as any).stripped?.content === '') {
    // 只有一张图时，它既可以当载体也可以当水印图，交由调用方决定
  }
  return { carrier, attached }
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

function describeError(result: any): string {
  const code = result?.code
  if (code === 'capacity') return '这张图太小，装不下这个水印：' + (result.message || '')
  if (code === 'too-long') return '水印内容太长：' + (result.message || '')
  if (code === 'no-python') return (result.message || '找不到 python') + '\n' + (result.hint || '')
  if (code === 'missing-deps') return '服务器缺少 Python 依赖：' + (result.message || '') + '\n请执行：pip install numpy opencv-python PyWavelets'
  if (code === 'timeout') return result.message || '调用超时'
  if (code === 'bad-image') return result.message || '图片无法解析'
  return (result?.message || '未知错误') + (result?.hint ? '\n' + result.hint : '')
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

  const root = ctx.command('bwm', '盲水印：往图片里嵌入 / 提取看不见的水印', { authority: config.authority })
    .alias('盲水印')

  root.subcommand('.embed <text:text>', '给图片打上文字盲水印')
    .alias('bwm.text')
    .usage('把要打水印的图片和这句话一起发出来，或先引用一张图片。水印是「盲」的：图片看不出任何变化，但随时能提取回来。')
    .example('bwm.embed 版权所有 maimai 2026')
    .option('bits', '-b <bits:number> 位宽，默认 512（约 61 字节文字）')
    .option('password', '-p <password:number> 图片密码（默认 1）')
    .option('watermarkPassword', '-w <password:number> 水印密码（默认 1）')
    .action(async ({ session, options }, text) => {
      if (!text) return '请写上水印文字，例如：bwm.embed 版权所有'
      const { carrier, attached } = splitImages(session)
      const url = carrier[0] || attached[0]
      if (!url) return '请把要打水印的图片一起发出来，或者引用一张图片。'
      let image: Buffer
      try {
        image = await downloadImage(ctx, url)
      } catch (error: any) {
        return '下载图片失败：' + (error?.message || error)
      }
      const result = await service.embedText(image, text, {
        bits: options.bits || config.bits,
        passwordImage: options.password,
        passwordWatermark: options.watermarkPassword,
      })
      if (!result.ok || !result.buffer) return describeError(result)
      const lines = [
        '水印已嵌入 ✅',
        '位宽 ' + result.bits + ' bit（容量 ' + result.capacity + ' bit）',
        '耗时 ' + result.elapsed + ' 秒' + (result.scaledFrom ? '（已从 ' + result.scaledFrom.join('x') + ' 缩放）' : ''),
        '提取时直接引用这张图即可：bwm.extract',
      ]
      await session.send(lines.join('\n'))
      return h.image(result.buffer, 'image/png')
    })

  root.subcommand('.extract [bits:number]', '从图片里提取文字盲水印')
    .alias('bwm.read')
    .usage('引用打过水印的图片，或在同一条消息里带上图片。默认会自动尝试常见位宽。')
    .example('bwm.extract')
    .option('password', '-p <password:number> 图片密码（默认 1）')
    .option('watermarkPassword', '-w <password:number> 水印密码（默认 1）')
    .action(async ({ session, options }, bits) => {
      const { carrier, attached } = splitImages(session)
      const url = carrier[0] || attached[0]
      if (!url) return '请引用（或发送）一张打过盲水印的图片。'
      let image: Buffer
      try {
        image = await downloadImage(ctx, url)
      } catch (error: any) {
        return '下载图片失败：' + (error?.message || error)
      }
      const result = await service.extractText(image, {
        bits: bits ? [bits] : config.candidateBits,
        passwordImage: options.password,
        passwordWatermark: options.watermarkPassword,
      })
      if (!result.ok) return describeError(result)
      if (!result.found) return result.message || '没有提取到水印（可能没打过水印、密码不对，或图片被压坏了）。'
      return '水印内容：' + result.text + '\n（位宽 ' + result.bits + ' bit，耗时 ' + result.elapsed + ' 秒）'
    })

  root.subcommand('.embed.logo', '给图片打上图片水印（用另一张图当水印）')
    .alias('bwm.logo')
    .usage('引用载体图片，再把作为水印的图片（建议黑底白字、64x64）一起发出来。')
    .option('password', '-p <password:number> 图片密码（默认 1）')
    .option('watermarkPassword', '-w <password:number> 水印密码（默认 1）')
    .action(async ({ session, options }) => {
      const { carrier, attached } = splitImages(session)
      if (!carrier.length) return '请先引用「载体图片」，再把「水印图片」一起发出来。'
      if (!attached.length) return '请把作为水印的图片一起发出来（建议黑底白字的 64x64 小图）。'
      let carrierImage: Buffer
      let logoImage: Buffer
      try {
        carrierImage = await downloadImage(ctx, carrier[0])
        logoImage = await downloadImage(ctx, attached[0])
      } catch (error: any) {
        return '下载图片失败：' + (error?.message || error)
      }
      const result = await service.embedLogo(carrierImage, logoImage, {
        passwordImage: options.password,
        passwordWatermark: options.watermarkPassword,
      })
      if (!result.ok || !result.buffer) return describeError(result)
      await session.send('图片水印已嵌入 ✅ 位宽 ' + result.bits + ' bit（容量 ' + result.capacity + ' bit），耗时 ' + result.elapsed + ' 秒\n提取：引用这张图 + 把同一张水印图发出来 → bwm.extract.logo')
      return h.image(result.buffer, 'image/png')
    })

  root.subcommand('.extract.logo [shape:string]', '提取图片水印')
    .alias('bwm.readLogo')
    .usage('引用打过水印的图片；把原水印图一起发出来最稳，也可以直接给尺寸（默认 ' + config.logoShape + '）。')
    .example('bwm.extract.logo 64x64')
    .option('password', '-p <password:number> 图片密码（默认 1）')
    .option('watermarkPassword', '-w <password:number> 水印密码（默认 1）')
    .action(async ({ session, options }, shape) => {
      const { carrier, attached } = splitImages(session)
      const url = carrier[0] || attached[0]
      if (!url) return '请引用（或发送）一张打过图片水印的图片。'
      let carrierImage: Buffer
      let logoImage: Buffer | undefined
      try {
        carrierImage = await downloadImage(ctx, url)
        const logoUrl = carrier.length ? attached[0] : attached[1]
        if (logoUrl) logoImage = await downloadImage(ctx, logoUrl)
      } catch (error: any) {
        return '下载图片失败：' + (error?.message || error)
      }
      const result = await service.extractLogo(carrierImage, {
        logo: logoImage,
        shape: shape || config.logoShape,
        passwordImage: options.password,
        passwordWatermark: options.watermarkPassword,
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
