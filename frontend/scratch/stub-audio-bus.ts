// 桩：WebAudio 混音总线只有实时合成（`composeGrid`）用，本用例测的是开录侧的护栏与清单形状，
// 不走那条路。两个导出都抛：真被走到就是"这条用例并不纯"，宁可炸出来。
export function ensureAudioBus(): never {
  throw new Error('桩被调用（ensureAudioBus）：这条用例不该走到混音总线')
}

export function hookMediaToBus(): never {
  throw new Error('桩被调用（hookMediaToBus）：这条用例不该走到混音总线')
}

export function currentAudioBus(): never {
  throw new Error('桩被调用（currentAudioBus）：这条用例不该走到混音总线')
}
