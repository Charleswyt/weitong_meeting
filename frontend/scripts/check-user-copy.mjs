// 第 38 项（界面文字不许出现技术细节 / 实现归属词）的可重复门禁。
//
// 为什么要有这个文件：这条规则连吃两次"零命中"的假阴性 —— 第一次只扫 title=/placeholder=/ElMessage.*
// 三种出口，第二次拿一份不列这些字段的镜像文档做 grep 判"三方没有该字段"。手扫不可靠，所以判据要能自己跑。
//
// 口径（三条都是刻意的）：
//   0. 管两件事：**第 38 项**（界面文字不许出现技术细节 / 实现归属词）与
//      **第 7 项**（后端 `msg` 只能原样上桌，不许前端加前缀或塞进模板拼一句）。
//   1. 只判**含中文的字符串字面量**与**模板里的可见文本节点** —— 用户看到的是中文句子，
//      而 `'token'`、`'Bearer '` 这类纯标识符字面量不是界面文字，扫它们只会产出噪声并让人把门禁关掉。
//      注释一律先剥掉：注释里的"三方"是逆向结论的出处，删掉等于把判据来源扔了。
//   2. `ElMessage.error(err.message)`（原样透传）是**要求**，不报；只有拼接与插值才报。
//   3. 启动时先跑一遍自检 —— **必须能命中已知坏样本、且不误报已知好样本**。
//      判不出坏样本的门禁比没有门禁更糟：它会让人把"0 命中"当成结论再报一次。
//
// 跑法：node scripts/check-user-copy.mjs   （命中则退出码 1）

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { join, dirname, relative } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(ROOT, 'src')

const BANNED = [
  '三方', '上游', '板卡', '船端', '岸端', '本地网关',
  'WHEP', 'WHIP', 'HLS', 'SDP', 'RTCPeerConnection', 'MediaRecorder', 'getStats', 'getUserMedia',
  'IndexedDB', 'DOMException', 'InvalidStateError', 'JWT', 'axios', 'HTTP 5', '/api/',
  'H.264', 'avc1', 'vp8', 'vp9', 'opus', 'codec', 'ROI', '二次压缩',
  '智音', 'Realtek', 'USB Camera', 'Blob', 'WebSocket', 'Service Worker',
  // 2026-10-09：回放页与录制列表上一轮"0 命中"却满屏实现词，就是因为下面这批词根本不在判据里。
  // 这一类不是厂商名词，是**把我方内部模型念给用户听**：归属/列号/状态通道/分路。
  // '落盘' 上一轮因本脚本会把块注释算成界面文字而暂摘（#18）；引号吞注释与跨行 console 两条根因已修，放回。
  '列号', '判定归属', '判不出归属', '落盘', '认领', '开发者工具', '本机存储', '分路',
  '字节增量', '状态通道', '会议服务',
]
const BANNED_RE = new RegExp(`(${BANNED.join('|')})`, 'g')
const CJK_RE = /[　-〿一-鿿＀-￯]/

// 第 7 项的另一半：后端给的 `msg` 只能**原样**上桌，不许前端再加前缀/后缀或塞进模板里拼一句。
// 只放行"改写"这一种形态：`ElMessage.error(err.message)`（原样透传）是**要求**，不是违规。
const MSG_DECORATE_RE = /\+\s*[A-Za-z_.$]*\.?(message|msg|Message)\b|\$\{[^}]*(message|msg|Message)\b/

/** 剥掉注释，返回"只剩代码与字符串"的文本；注释里的内容不参与判定。 */
function stripComments(src) {
  let out = ''
  let i = 0
  const n = src.length
  while (i < n) {
    const c = src[i]
    const two = src.slice(i, i + 2)
    if (two === '//' && src[i + 2] !== '/') {
      while (i < n && src[i] !== '\n') i++
      out += '\n'
      continue
    }
    if (two === '/*') {
      const end = src.indexOf('*/', i + 2)
      const stop = end === -1 ? n : end + 2
      out += src.slice(i, stop).replace(/[^\n]/g, ' ')
      i = stop
      continue
    }
    if (two === '<!' && src.slice(i, i + 4) === '<!--') {
      const end = src.indexOf('-->', i + 4)
      const stop = end === -1 ? n : end + 3
      out += src.slice(i, stop).replace(/[^\n]/g, ' ')
      i = stop
      continue
    }
    if (c === '"' || c === "'" || c === '`') {
      const quote = c
      // 单双引号**只认同一行内闭合的**。正则里带引号（`sanitizePathPart` 的 `/[\\/:*?"<>|]/`）时，
      // 从那个 `"` 一路找到下一处的"字符串"会把中间几十行的注释整段吞成字符串内容 ——
      // 于是注释里的词被当成界面文字报出来，而且报的行号比真实行偏后（#18 的根因）。
      const restOfLine = src.slice(i, src.indexOf('\n', i) === -1 ? n : src.indexOf('\n', i))
      const closesOnLine = quote === '`' ? true : restOfLine.indexOf(quote, 1) !== -1
      if (!closesOnLine) {
        out += c
        i++
        continue
      }
      out += c
      i++
      while (i < n) {
        if (src[i] === '\\') {
          out += src.slice(i, i + 2)
          i += 2
          continue
        }
        if (src[i] === quote) {
          out += quote
          i++
          break
        }
        out += src[i]
        i++
      }
      continue
    }
    out += c
    i++
  }
  return out
}

/** 从一行里抽出所有含中文的字符串字面量与模板可见文本。 */
function visibleTexts(line) {
  const hits = []
  const litRe = /'([^'\n]*)'|"([^"\n]*)"|`([^`\n]*)`/g
  let m
  while ((m = litRe.exec(line))) {
    const text = m[1] ?? m[2] ?? m[3]
    if (CJK_RE.test(text)) hits.push(text)
  }
  const textNodeRe = />([^<>]+)</g
  while ((m = textNodeRe.exec(line))) {
    const text = m[1].trim()
    if (text && CJK_RE.test(text)) hits.push(text)
  }
  return hits
}

function walk(dir) {
  const files = []
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'scratch' || name.startsWith('.')) continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) files.push(...walk(p))
    else if (/\.(vue|ts)$/.test(name)) files.push(p)
  }
  return files
}

/**
 * 这一行走完时是否仍停在某个 `console.*(` 调用里。
 * 从前只判"这一行有没有 console.x("，于是把模板参数换行写的日志当成界面文字报（第 38 项说得很清楚：
 * 技术细节走日志，正是该走的地方）。括号按行内计数配平，够真实代码用。
 */
function consoleDepthAfter(line, depthIn) {
  let depth = depthIn
  let i = 0
  if (depth === 0) {
    const m = /console\.(?:log|info|warn|error|debug)\s*\(/.exec(line)
    if (!m) return 0
    depth = 1
    i = m.index + m[0].length
  }
  for (; i < line.length; i++) {
    if (line[i] === '(') depth++
    else if (line[i] === ')') depth--
  }
  return Math.max(depth, 0)
}

export function scanText(text) {
  const findings = []
  const stripped = stripComments(text)
  let consoleDepth = 0
  stripped.split('\n').forEach((line, idx) => {
    // 控制台是调试通道，按约定就该装技术内容（第 38 项的另一半：技术细节走日志，不走界面）。
    // 整个调用（含跨行的参数）都跳过，但**闭合之后的下一行照常判**，不许一泄到底。
    const inConsole = consoleDepth > 0 || /console\.(?:log|info|warn|error|debug)\s*\(/.test(line)
    consoleDepth = consoleDepthAfter(line, consoleDepth)
    if (inConsole) return
    for (const snippet of visibleTexts(line)) {
      const nouns = [...new Set(snippet.match(BANNED_RE) || [])]
      if (nouns.length) findings.push({ line: idx + 1, snippet, nouns })
    }
    // 第二类：把后端 msg 拼进一句自造的话里（第 7 项：前端只照实渲染，不做翻译层）。
    if (MSG_DECORATE_RE.test(line)) {
      findings.push({ line: idx + 1, snippet: line.trim().slice(0, 120), nouns: ['改写后端 msg'] })
    }
  })
  return findings
}

// 自检：两类已知坏文案必须命中，五类已知好内容必须不命中。
function selfTest() {
  const mustFlag = scanText(`x.title = '云端录制由三方系统存储与回收'`).length === 1
  const mustFlagConcat = scanText(`ElMessage.error('保存失败：' + e.message)`).length === 1
  const mustFlagTemplate = scanText('ElMessage.error(`出错了：${err.message}`)').length === 1
  const mustNotFlagPassthrough = scanText(`ElMessage.error(err.message)`).length === 0
  const mustNotFlagCode = scanText(`const t = sessionStorage.getItem('token')`).length === 0
  const mustNotFlagComment = scanText('// 口径照三方会议页的实现\nconst t = 1').length === 0
  const mustNotFlagHtmlComment = scanText('<!-- 对齐三方会中面板 -->\n<div>正常</div>').length === 0
  const mustNotFlagConsole = scanText("console.warn('[replay] 这一路 HLS 致命错误', d.type)").length === 0
  // 自检样本就用**真实漏掉过的那两句**：判据抓不住它们，等于这一轮的"0 命中"还是假的。
  const mustFlagInternal = scanText(`x.title = '本地录制仅本机录制者可见，画面与声音分路保存'`).length === 1
    && scanText(`<p>没有记下列号，请用浏览器开发者工具本机存储处理</p>`).length === 1
  // #18 的两条根因：正则里的引号不许把后面的注释吞成"字符串"（那会连行号一起偏后）；
  // 跨行写的 console 参数是日志，不是界面文字
  // 样本必须带**注释里成对的 ASCII 引号，且禁词就在那一对引号中间** —— 真实漏报就是这个形状：
  // 正则里那个落单的 `"` 一路找到后面注释的第一个 `"`，于是 `"授权目录 + 真落盘"` 这类
  // 注释里的引号对被当成字符串字面量报出来，行号还比真实行偏后几十行。
  const mustNotFlagRegexQuote = scanText(
    [
      'const re = /[\\\\/:*?"<>|]/g',
      "  return s && s !== '.' ? s : fallback",
      '// 磁盘扫描只覆盖"授权目录 + 真落盘"那部分',
      'const a = 1',
    ].join('\n'),
  ).length === 0
  const mustNotFlagConsoleMultiline = scanText('console.info(\n  `本机条目：判不出归属 3 条`\n)').length === 0
  // 但豁免不许一泄到底：console 闭合之后的界面文字仍要抓到，否则这条口子比没有门禁更糟
  const mustFlagAfterConsole =
    scanText("console.info('日志')\nElMessage.error('这条判不出归属')").length === 1
  const checks = [
    mustFlag, mustFlagConcat, mustFlagTemplate, mustFlagInternal,
    mustNotFlagPassthrough, mustNotFlagCode, mustNotFlagComment,
    mustNotFlagHtmlComment, mustNotFlagConsole,
    mustNotFlagRegexQuote, mustNotFlagConsoleMultiline, mustFlagAfterConsole,
  ]
  if (checks.some((c) => !c)) {
    console.error(
      `自检失败：命中[技术名词=${mustFlag} 拼接=${mustFlagConcat} 模板插值=${mustFlagTemplate} 内部模型词=${mustFlagInternal} console 之后=${mustFlagAfterConsole}] ` +
        `不误报[原样透传=${mustNotFlagPassthrough} 标识符=${mustNotFlagCode} 行注释=${mustNotFlagComment} ` +
        `模板块注释=${mustNotFlagHtmlComment} 控制台=${mustNotFlagConsole} 正则含引号=${mustNotFlagRegexQuote} 跨行控制台=${mustNotFlagConsoleMultiline}]`,
    )
    console.error('→ 判据本身坏了，此时的"0 命中"没有任何意义。先修这个脚本再谈结果。')
    process.exit(2)
  }
  console.log(`自检 ${checks.length} 条全过（三类坏文案 + console 之后的界面文字都抓得到；透传 msg / 注释 / 控制台 / 标识符不误报）`)
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  selfTest()
  let total = 0
  for (const file of walk(SRC)) {
    const findings = scanText(readFileSync(file, 'utf8'))
    for (const f of findings) {
      total++
      console.log(`${relative(ROOT, file)}:${f.line}  名词[${f.nouns.join(', ')}]  「${f.snippet}」`)
    }
  }
  if (total) {
    console.log(`\n界面文字里还有 ${total} 处技术细节 —— 换成用户能行动的一句中文，原信息进 console/日志。`)
    process.exit(1)
  }
  console.log('界面文案（第 38 项的技术名词 + 第 7 项的改写 msg）：0 命中（判据自检已过，见本文件头部口径）')
}
