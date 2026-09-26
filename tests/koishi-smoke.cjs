/**
 * 冒烟测试：在一个真实的 Koishi Context 里加载插件，确认
 *   - 插件能正常 apply（不抛错）
 *   - ctx.bwm 服务注册成功
 *   - 命令都注册进了命令表
 *
 * 用 CJS 运行：node tests/koishi-smoke.cjs
 * （koishi 的 loader 在 ESM 下 interop 有问题，所以这里走 require）
 */
const { Context } = require('koishi')
const plugin = require('../lib/index.js')

async function main() {
  const ctx = new Context()
  ctx.plugin(plugin, { pythonPath: process.env.PYTHON || 'python', selfCheck: false })
  await ctx.start()

  const service = ctx.bwm
  console.log('插件名:', plugin.name)
  console.log('ctx.bwm 类型:', service && service.constructor && service.constructor.name)
  console.log('脚本路径:', service && service.script)

  const names = []
  try {
    const list = ctx.$commander._commandList || []
    for (const item of list) if (item && item.name) names.push(item.name)
  } catch { /* 忽略 */ }
  console.log('已注册命令:', names.filter((name) => name.indexOf('bwm') === 0).join(', ') || '(未探测到)')

  let failed = 0
  const check = (name, ok, detail) => {
    if (ok) console.log('  ✔ ' + name + (detail ? '  ' + detail : ''))
    else { failed++; console.log('  ✘ ' + name + (detail ? '  ' + detail : '')) }
  }
  check('插件加载成功', !!service)
  check('ctx.bwm.embedText 可用', typeof (service && service.embedText) === 'function')
  check('ctx.bwm.extractText 可用', typeof (service && service.extractText) === 'function')
  check('命令 bwm.embed 已注册', names.indexOf('bwm.embed') >= 0)
  check('命令 bwm.extract 已注册', names.indexOf('bwm.extract') >= 0)

  await ctx.stop()
  console.log(failed ? '\n失败 ' + failed + ' 项' : '\n冒烟测试通过 ✅')
  process.exit(failed ? 1 : 0)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
