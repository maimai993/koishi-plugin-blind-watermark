/**
 * 命令层集成测试：直接跑 bwm.embed / bwm.extract 的 action，
 * 覆盖用户反馈的两个坑：
 *   1. 指令里带了图片时，argv 的 text 会把 <img src="..."/> 也塞进来 -> 水印文字被算成几百字节
 *   2. 指令没写水印文字 / 没带图片时，应该交互式追问，而不是直接报错
 *
 *   node tests/command-test.cjs
 */
const { Context, h } = require('koishi')
const { readFile } = require('node:fs/promises')
const { join } = require('node:path')
const plugin = require('../lib/index.js')

const root = join(__dirname, '..')
let failed = 0
function check(name, ok, detail) {
  if (ok) console.log('  ✔ ' + name + (detail ? '  ' + detail : ''))
  else { failed++; console.log('  ✘ ' + name + (detail ? '  ' + detail : '')) }
}

/** 造一个假 session：内容用消息元素数组，prompt 按脚本回答，send 收集回复 */
function makeSession(elements, answers = [], quote = null) {
  const sent = []
  const session = {
    selfId: 'bot-1',
    userId: 'user-1',
    channelId: 'channel-1',
    event: { message: { content: elements } },
    app: { koishi: { config: {} } },
    quote,
    stripped: { content: '' },
    async send(content) { sent.push(content); return ['m1'] },
    async prompt() { return answers.length ? answers.shift() : null },
  }
  return { session, sent }
}

function runAction(cmd, session, args = []) {
  const action = cmd._actions[cmd._actions.length - 1]
  return action.call(cmd, { session, options: {}, args }, ...args)
}

/** 把 action 返回的元素还原成图片（Buffer / data URL 都认） */
function toImageBuffer(result) {
  const list = Array.isArray(result) ? result : [result]
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const src = item.attrs && item.attrs.src
    if (Buffer.isBuffer(src)) return src
    if (typeof src === 'string' && src.startsWith('data:')) {
      return Buffer.from(src.slice(src.indexOf(',') + 1), 'base64')
    }
  }
  return null
}

function textOf(result) {
  const list = Array.isArray(result) ? result : [result]
  return list.map((item) => (typeof item === 'string' ? item : item && item.attrs && item.attrs.src ? '' : '')).join(' ') +
    (typeof result === 'string' ? result : '')
}

async function main() {
  const ctx = new Context()
  ctx.plugin(plugin, { pythonPath: process.env.PYTHON || 'python', selfCheck: false })
  await ctx.start()

  const list = ctx.$commander._commandList
  const embed = list.find((item) => item.name === 'bwm.embed')
  const extract = list.find((item) => item.name === 'bwm.extract')
  check('命令已注册', !!embed && !!extract)

  const carrier = await readFile(join(root, 'upstream', 'examples', 'pic', 'ori_img.jpeg'))
  const dataUrl = 'data:image/jpeg;base64,' + carrier.toString('base64')
  // 模拟真实平台：图片元素是超长的 CDN 链接（这里用 data URL 代替，长度量级相似）
  const imgElement = h.image(dataUrl)

  console.log('1) 指令里同时带文字和图片（用户报的 bug）')
  const argvText = '麦麦 ' + String(imgElement) // argv 里就是这个样子
  const s1 = makeSession([{ type: 'at', attrs: { id: 'bot-1' } }, { type: 'text', attrs: { content: ' /bwm.embed 麦麦 ' } }, imgElement])
  const r1 = await runAction(embed, s1.session, [argvText])
  const sent1 = s1.sent.join('\n')
  check('没有出现「太长」错误', !/太长/.test(sent1) && !/太长/.test(textOf(r1)), sent1.split('\n')[0] || '')
  check('提示已嵌入', /水印已嵌入/.test(sent1))
  check('回复里带了图片', !!toImageBuffer(r1))
  const watermarked = toImageBuffer(r1)
  if (watermarked) await require('node:fs/promises').writeFile(join(root, '_test_watermarked.png'), watermarked)

  console.log('2) 引用打好的图提取水印')
  if (watermarked) {
    const s2 = makeSession([{ type: 'text', attrs: { content: 'bwm.extract' } }], [], { content: [h.image('data:image/png;base64,' + watermarked.toString('base64'))] })
    const r2 = await runAction(extract, s2.session, [])
    check('提取到水印', /水印内容：麦麦/.test(String(r2)), String(r2).split('\n')[0])
  }

  console.log('3) 交互式：只发 bwm.embed，先问文字再问图片')
  const s3 = makeSession([{ type: 'text', attrs: { content: '/bwm.embed' } }], ['麦麦', '<img src="' + dataUrl + '"/>'])
  const r3 = await runAction(embed, s3.session, [])
  const asks = s3.sent.join('\n')
  check('先追问水印文字', /水印文字/.test(asks), asks.split('\n')[0])
  check('追问后成功嵌入', /水印已嵌入/.test(asks) && !!toImageBuffer(r3))

  console.log('4) 交互式：没带图片时会追问图片')
  const s4 = makeSession([{ type: 'text', attrs: { content: '/bwm.embed 麦麦' } }], ['<img src="' + dataUrl + '"/>'])
  const r4 = await runAction(embed, s4.session, ['麦麦'])
  check('追问图片后成功嵌入', /水印已嵌入/.test(s4.sent.join('\n')) && !!toImageBuffer(r4))

  console.log('5) 取消与超时')
  const s5 = makeSession([{ type: 'text', attrs: { content: '/bwm.embed' } }], ['取消'])
  const r5 = await runAction(embed, s5.session, [])
  check('发送「取消」可退出', /已取消/.test(String(r5)), String(r5))
  const s6 = makeSession([{ type: 'text', attrs: { content: '/bwm.embed' } }], [])
  const r6 = await runAction(embed, s6.session, [])
  check('超时有提示', /取消|超时|等太久/.test(String(r6)), String(r6))

  console.log('6) 纯文本指令（不带图片）依然提示要图片')
  const s7 = makeSession([{ type: 'text', attrs: { content: '/bwm.embed 麦麦' } }], [])
  const r7 = await runAction(embed, s7.session, ['麦麦'])
  check('没有图片时给出提示', /没有收到图片|请发送/.test(String(r7)), String(r7))

  await ctx.stop()
  console.log(failed ? '\n失败 ' + failed + ' 项' : '\n命令层测试全部通过 ✅')
  process.exit(failed ? 1 : 0)
}

main().catch((error) => { console.error(error); process.exit(1) })
