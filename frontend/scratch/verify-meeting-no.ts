/**
 * 会议号显示形态的用例（node scratch/verify-meeting-no.ts）。
 *
 * 钉的是收口后的那一条规则：三方文档说号是 **6–12 位**
 * （`platform/contracts/edge-to-cloud/EXTERNAL_HTTPS_CONFERENCE_API.md` 开头那节），
 * 而收口前 `AllMeetingsView`/`DashboardView` 那两份逐字相同的写法**只在正好 8 位时**才分组
 * —— 9–12 位直接糊成一串上桌。这里既钉 8 位的显示一字未变（免得改动波及现网观感），
 * 也钉住"其余长度各有明确归宿"，判据坏了一眼能看见。
 */
import { formatMeetingNo, MEETING_NO_ABSENT, MEETING_NO_ABSENT_HINT } from '../src/utils/meetingNo.ts'

let checks = 0
const fails: string[] = []
function eq(name: string, got: unknown, want: unknown) {
  checks++
  if (got !== want) fails.push(`${name} :: got ${String(got)} want ${String(want)}`)
}

// —— 8 位：与收口前那两份写法逐字相同（现网两张卡片不许因为收口而变样）
eq('8 位对半', formatMeetingNo('48124890'), '4812 4890')
eq('8 位含非数字时按剔除后的位数判', formatMeetingNo('4812 4890.'), '4812 4890')

// —— 12 位：新规则给三组（旧写法是原样一串）
eq('12 位分三组', formatMeetingNo('123456789012'), '1234 5678 9012')

// —— 其余长度：原样。6 位切成 `1234 56` 比整串更难读，9/10/11 位没有整齐的切法
for (const no of ['123456', '1234567', '123456789', '1234567890', '12345678901']) {
  eq(`${no.length} 位原样`, formatMeetingNo(no), no)
}

// —— 空号：界面必须有那句如实的话可上桌，而且不许是空白或 `—`（空白会被当成渲染坏了）
eq('空号那句不是空白', MEETING_NO_ABSENT.trim().length > 0, true)
eq('空号那句不带技术词', /接口|后端|三方|服务/.test(MEETING_NO_ABSENT), false)
// 悬浮说明同样上桌（`check:copy` 会抓厂商/接口名），两处界面共用这一份取词
eq('空号那句的说明不带技术词', /接口|后端|三方|服务/.test(MEETING_NO_ABSENT_HINT), false)

console.log(fails.length ? `❌ ${fails.length}/${checks} 条失败：\n  ${fails.join('\n  ')}` : `✓ 会议号形态全绿：${checks} 条断言`)
process.exit(fails.length ? 1 : 0)
