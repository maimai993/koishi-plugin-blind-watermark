import { spawn } from 'node:child_process'

/** 调用 python 桥所需的参数 */
export interface BridgeOptions {
  /** python 可执行文件：PATH 里的名字（python / python3）或绝对路径 */
  python: string
  /** bwm_cli.py 的绝对路径 */
  script: string
  /** 单次调用超时（毫秒），默认 120 秒 —— 打水印的耗时和像素数成正比 */
  timeout?: number
}

/** python 桥统一返回的结构，字段和 bwm_cli.py 的协议一致 */
export interface BridgeResult {
  ok: boolean
  code?: string
  message?: string
  hint?: string
  [key: string]: any
}

/** 单个流最多保留多少输出，防止异常时把内存吃满 */
const MAX_OUTPUT = 4 * 1024 * 1024

/**
 * blind_watermark 的 Python 桥。
 *
 * 只负责「起一个 python 子进程、把结果读回来」，不碰临时文件、不做并发控制。
 */
export class PythonBridge {
  constructor(private options: BridgeOptions) {}

  get python() {
    return this.options.python
  }

  get script() {
    return this.options.script
  }

  get timeout() {
    return this.options.timeout ?? 120000
  }

  /** 跑一次 bwm_cli.py，返回它输出的 JSON（永远 resolve，错误体现在 result.ok / result.code 上） */
  async run(args: string[], timeout = this.timeout): Promise<BridgeResult> {
    return new Promise<BridgeResult>((resolve) => {
      let child
      try {
        child = spawn(this.python, [this.script, ...args], {
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        })
      } catch (error: any) {
        resolve({
          ok: false,
          code: 'spawn-failed',
          message: '无法启动 python：' + (error?.message || error),
        })
        return
      }

      let stdout = ''
      let stderr = ''
      let settled = false
      let timedOut = false

      const append = (target: string, chunk: any) => {
        if (target.length >= MAX_OUTPUT) return target
        return target + String(chunk)
      }

      child.stdout?.on('data', (chunk) => { stdout = append(stdout, chunk) })
      child.stderr?.on('data', (chunk) => { stderr = append(stderr, chunk) })

      const timer = setTimeout(() => {
        timedOut = true
        try { child.kill() } catch { /* 忽略 */ }
      }, Math.max(1000, timeout))

      const finish = (result: BridgeResult) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (stderr.trim()) result.stderr = stderr.trim().slice(-2000)
        resolve(result)
      }

      child.on('error', (error: any) => {
        clearTimeout(timer)
        if (error?.code === 'ENOENT') {
          finish({
            ok: false,
            code: 'no-python',
            message: '找不到 python 可执行文件：' + this.python,
            hint: '请在插件配置里把 pythonPath 改成正确的 python（例如 C:\\Python311\\python.exe）',
          })
        } else {
          finish({ ok: false, code: 'spawn-failed', message: error?.message || String(error) })
        }
      })

      child.on('close', (code) => {
        if (timedOut) {
          finish({
            ok: false,
            code: 'timeout',
            message: 'python 调用超时（' + Math.round(timeout / 1000) + ' 秒），图片太大或服务器太慢，可调大 timeout / 调小 maxSize',
          })
          return
        }
        const parsed = parseJsonOutput(stdout)
        if (parsed) {
          finish(parsed)
          return
        }
        finish({
          ok: false,
          code: 'bad-output',
          message: 'python 没有返回可解析的 JSON（退出码 ' + code + '）',
        })
      })
    })
  }
}

/** 从 stdout 里找最后一行能解析成 JSON 对象的内容 */
export function parseJsonOutput(stdout: string): BridgeResult | null {
  const lines = stdout.split(/\r?\n/).filter((line) => line.trim().startsWith('{'))
  for (let index = lines.length - 1; index >= 0; index--) {
    try {
      const value = JSON.parse(lines[index])
      if (value && typeof value === 'object' && typeof value.ok === 'boolean') return value as BridgeResult
    } catch { /* 继续往上找 */ }
  }
  return null
}
