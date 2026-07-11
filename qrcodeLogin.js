import { createRequire } from 'module'
import fs from 'node:fs'
import { close_api, delay, send, startService } from "./utils/utils.js";
import { printGreen, printMagenta, printRed, printYellow } from "./utils/colorOut.js";
import { summarizeResponse } from "./utils/safeLog.js";
import { upsertUser, saveUserinfo } from "./utils/userinfo.js";

const require = createRequire(import.meta.url)
const QRCode = require('./api/node_modules/qrcode')

// GitHub Actions 运行环境下，step summary 文件路径由该变量提供（Actions 自动注入）
const SUMMARY_FILE = process.env.GITHUB_STEP_SUMMARY
const QR_DIR = './qr'
const KEYS_FILE = './qrkeys.json'

/**
 * 向 GitHub Step Summary 追加内容（本地或非 Actions 环境自动跳过）
 * @param {string} markdown
 */
function appendSummary(markdown) {
  if (!SUMMARY_FILE) return
  try {
    fs.appendFileSync(SUMMARY_FILE, markdown)
  } catch {
    // 写入摘要失败不影响主流程
  }
}

/**
 * 生成并展示单个二维码（图片优先方案）
 *
 * 展示层级（按可扫性从高到低）：
 *   1. Summary 摘要页：真实 PNG 图片（<img> data URI），手机直接扫
 *   2. Artifact 下载：qr/qr-N.png 高清文件
 *   3. 日志链接兜底：酷狗扫码 URL，复制到 App 内打开
 *
 * @param {string} url 酷狗扫码登录完整 URL
 * @param {number} index 从 1 开始
 * @param {number} total 总账号数
 */
async function buildQr(url, index, total) {
  const header = total > 1 ? `（第 ${index}/${total} 个账号）` : ''

  fs.mkdirSync(QR_DIR, { recursive: true })

  // ── 1) 生成 PNG 文件（artifact 下载用）──
  await QRCode.toFile(`${QR_DIR}/qr-${index}.png`, url, { width: 320, margin: 2 })

  // ── 2) 在运行摘要（Summary）中嵌入真实可扫的二维码图片 ← 核心展示渠道 ──
  const dataUrl = await QRCode.toDataURL(url, { width: 320, margin: 2 })
  appendSummary([
    `## 🎵 酷狗音乐扫码登录${header}`,
    '',
    '### 请使用 **酷狗音乐 APP** 扫描下方二维码 👇',
    '',
    `<p><img src="${dataUrl}" alt="酷狗扫码登录二维码${header}" width="320" style="border:2px solid #e1e4e8;border-radius:8px;padding:8px;background:#fff;" /></p>`,
    '',
    '> ⏳ 二维码有效期约 **2 分钟**，请尽快扫描。扫描后工作流会自动检测登录状态。',
    '',
    '**如上方图片未加载或无法扫描**，可复制以下链接到酷狗音乐 App 内打开：',
    '',
    `<code>${url}</code>`,
    '',
    '---',
    '',
  ].join('\n'))

  // ── 3) 日志输出：清晰指引用户去 Summary 页看图 ──
  printMagenta(`\n═══ 第 ${index}/${total} 个登录二维码已生成 ═══`)
  printMagenta(`👉 请点击本页面上方的「**Summary**」标签查看可扫描的二维码图片`)
  printMagenta(`   或在页面左侧导航栏找到「Run details → Summary」`)
  printMagenta(`\n📋 扫码备用链接（复制到酷狗 App 打开）：`)
  console.log(`   ${url}`)
  console.log('')
}

/** 解析账号数量 */
function resolveNumber() {
  const args = process.argv.slice(3)
  return parseInt(process.env.NUMBER || args[0] || "1")
}

/**
 * 模式一：生成二维码（PNG 图片写入 Summary），随后立即结束 step。
 * step 结束后 Summary 页会刷新显示真实二维码图片，用户可直接扫描。
 */
async function genMode() {
  const api = startService()
  await delay(2000)
  const USERINFO = process.env.USERINFO
  const APPEND_USER = process.env.APPEND_USER
  const userinfo = (USERINFO && APPEND_USER == "是") ? JSON.parse(USERINFO) : []
  const number = resolveNumber()
  const keys = []
  try {
    for (let n = 0; n < number; n++) {
      const result = await send(`/login/qr/key?timestrap=${Date.now()}`, "GET", {})
      if (result.status === 1) {
        const qrcode = result.data.qrcode
        const qrUrl = `https://h5.kugou.com/apps/loginQRCode/html/index.html?qrcode=${qrcode}`
        keys.push(qrcode)
        await buildQr(qrUrl, n + 1, number)
      } else {
        printRed("响应内容")
        console.dir(summarizeResponse(result), { depth: null })
        throw new Error(`获取二维码密钥失败：接口返回 status=${result.status}`)
      }
    }
    fs.writeFileSync(KEYS_FILE, JSON.stringify({ number, keys }))
    printMagenta(`\n✅ 已生成 ${number} 个二维码图片。`)
    printMagenta(`📱 现在请前往【Summary】页面扫描二维码，工作流会在此步骤结束后自动进入等待阶段。`)
  } catch (e) {
    const msg = e && e.message ? e.message : String(e)
    console.error(`::error::二维码生成失败：${msg}`)
    throw e
  } finally {
    close_api(api)
  }
}

/**
 * 模式二：读取已生成的二维码密钥，轮询等待用户扫码确认
 */
async function waitMode() {
  const api = startService()
  await delay(2000)
  let parsed
  try {
    parsed = JSON.parse(fs.readFileSync(KEYS_FILE, 'utf8'))
  } catch {
    throw new Error('未找到二维码密钥文件，请确认已先运行「生成登录二维码」步骤')
  }
  const { number, keys } = parsed
  const USERINFO = process.env.USERINFO
  const APPEND_USER = process.env.APPEND_USER
  const userinfo = (USERINFO && APPEND_USER == "是") ? JSON.parse(USERINFO) : []

  try {
    for (let n = 0; n < number; n++) {
      const qrcode = keys[n]
      printMagenta(`\n正在等待第 ${n + 1}/${number} 个账号扫码登录...`)
      let loggedIn = false
      for (let i = 0; i < 30; i++) {
        const timestrap = Date.now();
        const res = await send(`/login/qr/check?key=${qrcode}&timestrap=${timestrap}`, "GET", {})
        const status = res?.data?.status
        switch (status) {
          case 0:
            printYellow("二维码已过期，请重新运行工作流生成新二维码")
            break

          case 1:
            // 未扫描二维码
            break

          case 2:
            // 二维码未确认，请点击确认登录
            break

          case 4:
            printGreen("登录成功！")
            upsertUser(userinfo, { userid: res.data.userid, token: res.data.token }, APPEND_USER == "是")
            loggedIn = true
            break

          default:
            printRed("请求出错")
            console.dir(summarizeResponse(res), { depth: null })
        }
        if (loggedIn || status == 0) {
          break
        }
        if (i == 29) {
          printRed("等待超时\n")
        }
        await delay(5000)
      }
    }
    saveUserinfo(userinfo)
  } finally {
    close_api(api)
  }
}

const mode = process.argv[2] || 'gen'
if (mode === 'wait') {
  waitMode()
} else {
  genMode()
}
