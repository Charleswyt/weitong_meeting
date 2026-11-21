// 「按住」状态机的回归用例（纯逻辑，node 直跑：`node scratch/verify-hold.ts`）。
//
// 存在的唯一理由：2026-09-30 现场那个"回来没有自动播放" ——
// 旧写法把"此刻不可见"与"我正在按住"混成一个谓词当入参，回来时 `held === holding` 命中直接 return，
// `holding` 永远解不开。第 1 条用例就是钉死这件事（旧写法必红）。
import { createHoldController } from '../src/utils/visibilityHold.ts'

let failed = 0
const check = (name: string, ok: boolean, detail = '') => {
  if (!ok) failed++
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` —— ${detail}` : ''}`)
}

/** 造一个可控可见性的状态机 + 记事本 */
function fixture() {
  let hidden = false
  let clock = 1_000
  const events: string[] = []
  const hold = createHoldController({
    isHidden: () => hidden,
    onHold: () => events.push('hold'),
    onResume: () => events.push('resume'),
    now: () => clock,
  })
  return {
    hold,
    events,
    setHidden(v: boolean) {
      hidden = v
      hold.sync()
    },
    advance(ms: number) {
      clock += ms
    },
    get hidden() {
      return hidden
    },
  }
}

// 1) 切走一次再回来：必须 hold 一次、resume 一次，且回来之后 isHeld() 立刻为假
{
  const f = fixture()
  f.setHidden(true)
  check('切走：状态机进入按住', f.hold.isHeld() === true && f.events.join(',') === 'hold', f.events.join(','))
  f.setHidden(false)
  check(
    '回来：必须解除按住（旧写法在这里卡死）',
    f.hold.isHeld() === false && f.events.join(',') === 'hold,resume',
    `isHeld=${f.hold.isHeld()} events=${f.events.join(',')}`,
  )
}

// 2) 重复切走/回来都要一一对应（不能只成对一次）
{
  const f = fixture()
  f.setHidden(true)
  f.setHidden(false)
  f.setHidden(true)
  f.setHidden(false)
  check('来回两轮：hold/resume 各两次', f.events.join(',') === 'hold,resume,hold,resume', f.events.join(','))
}

// 3) 可见性没变就不该重复触发（避免把"没变化"也算成一次按住）
{
  const f = fixture()
  f.setHidden(true)
  f.setHidden(true)
  check('可见性未变：不重复触发', f.events.join(',') === 'hold', f.events.join(','))
}

// 4) 按住时长按真实时钟累计（只统计被按住的那些毫秒）
{
  const f = fixture()
  f.setHidden(true)
  f.advance(3000)
  f.setHidden(false)
  f.advance(1000)
  f.setHidden(true)
  f.advance(2000)
  f.setHidden(false)
  const s = f.hold.stats()
  check('按住统计：2 次共 5000ms', s.count === 2 && s.ms === 5000, JSON.stringify(s))
}

// 5) `isHeld()` 的语义：只要此刻不可见就算"该按住"，即使 sync() 还没被调到
{
  const f = fixture()
  f.hidden // 触发 getter，保持形态清楚
  const hold = createHoldController({ isHidden: () => true, onHold: () => {}, onResume: () => {} })
  check('未 sync 但已不可见：isHeld() 也要为真（composeGrid 的看门狗据此不判停摆）', hold.isHeld() === true)
}

console.log(`\n断言结果：${failed === 0 ? '全部通过' : `${failed} 项失败`}`)
process.exit(failed === 0 ? 0 : 1)
