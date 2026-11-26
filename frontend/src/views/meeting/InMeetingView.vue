<template>
  <div class="im-root" :class="{ 'is-phone': isPhone, 'is-tablet': isTablet, 'is-compact': isCompact }">
    <!-- 顶部状态条：会议名 / 状态；窄屏只留关键告警，细节进「更多」 -->
    <header class="im-topbar" :inert="!admitted">
      <div class="im-top-left">
        <span class="im-title" :title="meetingStore.title || '会议'">{{ meetingStore.title || '会议' }}</span>
        <span v-if="kindBadge" class="im-badge im-badge-kind im-badge-desk">{{ kindBadge }}</span>
        <span class="im-badge" :class="statusClass">{{ statusLabel }}</span>
        <span v-if="cloudRecording" class="im-badge im-badge-rec">云录制中</span>
        <span v-if="assistant?.state?.transcription.active" class="im-badge" title="已发布的麦克风正在生成会议字幕">转录中</span>
        <span v-if="sharing" class="im-badge im-badge-share im-badge-desk">共享中</span>
        <!-- 链路正常时不占位，只在异常时挂出可操作的告警。
             状态通道与画面是两条腿：断了的是"谁进出/谁开麦"这些消息，画面照常在动，
             所以一句"连接断开"是骗人的 —— 重连在途说"正在重连"，持续断开才说后果。 -->
        <span v-if="wsLost" class="im-badge im-badge-warn" title="收不到成员与开关变化了，画面不会自动更新；退出重进可恢复">{{ isCompact ? '已断开' : '连接已断开，画面可能不再更新' }}</span>
        <span v-else-if="!wsOk" class="im-badge im-badge-warn" title="与会议的连接断了，正在重连">正在重连</span>
        <!-- publishState 只有摄像头那条 WHIP 在喂（音频发布没有 onState），所以这块徽章说的是
             "画面这条腿没连上"。没要画面的人（关摄像头入会、只开麦）不该看见故障 —— 采不到设备时
             cameraOn 已置 false，另有"未采集到画面"那句负责报。
             只在**真掉下来**时亮（推流中断/失败/已关闭）：从没回调过状态、正在建立都不算故障，
             否则正常入会的一两秒里会先挂一块"本端发布异常"，而它的 title 写着"未推流"。 -->
        <span v-else-if="cameraOn && publishFaulty" class="im-badge im-badge-warn" :title="publishLabel">{{ isCompact ? '发布异常' : '本端发布异常' }}</span>
        <span
          v-else-if="net && net.level !== 'good'"
          class="im-badge im-badge-warn im-badge-desk"
          :title="netTitle"
        >网络{{ net.label }} {{ net.rttMs }}ms</span>
      </div>

      <div class="im-top-right">
        <el-dropdown v-if="!isPhone" trigger="click" @command="(v: unknown) => pickLayout(v as LayoutId)">
          <button class="im-layout-btn" :title="'画面排列：' + layoutLabel">
            <i :class="layoutIcon" class="im-layout-ic" /><i class="ri-arrow-down-s-line im-layout-chev" />
          </button>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item v-for="l in layouts" :key="l.value" :command="l.value">
                <i :class="LAYOUT_ICONS[l.value]" class="im-layout-menu-ic" /> {{ l.label }}
              </el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
        <button v-if="!isPhone" class="im-icon-btn" title="设置" @click="showSettings = true"><i class="ri-settings-3-line" /></button>
        <button v-if="!isPhone" class="im-icon-btn" :title="isFullscreen ? '退出全屏' : '全屏'" @click="toggleFullscreen">
          <i :class="isFullscreen ? 'ri-fullscreen-exit-line' : 'ri-fullscreen-line'" />
        </button>
        <button class="im-icon-btn" title="离开会议" @click="leave"><i class="ri-close-line" /></button>
      </div>
    </header>

    <div class="im-main">
      <!-- 舞台：自己的预览 + 远端流 -->
      <main
        class="im-stage"
        :class="[
          'im-stage-' + layout,
          { 'is-sharing': !!shareStreamId, 'im-stage-voice': isVoiceMode, 'im-stage-share-mode': isShareMode },
        ]"
        @mouseenter="revealStatBar"
      >
        <!-- 语音对讲：不排视频宫格，中央展示对方头像/名称 + 卫通云连接效果 -->
        <div v-if="isVoiceMode" class="voice-stage">
          <div class="voice-orbit" :class="{ 'has-peer': voiceRemotePeers.length > 0 }">
            <div class="voice-cloud" aria-hidden="true">
              <span class="voice-cloud-ring" />
              <span class="voice-cloud-ring delay" />
              <i class="ri-cloud-fill voice-cloud-ic" />
              <span class="voice-cloud-label">卫通云</span>
            </div>
            <div
              v-for="(p, idx) in voiceStagePeers"
              :key="p.key"
              class="voice-peer"
              :class="{
                self: p.isSelf,
                speaking: p.speaking,
                remote: !p.isSelf,
              }"
              :style="{ '--peer-i': String(idx) }"
            >
              <div class="voice-peer-link" aria-hidden="true" />
              <div class="voice-peer-avatar">
                <img v-if="tileAvatarSrc(p)" :src="tileAvatarSrc(p)" :alt="p.name" @error="markAvatarBroken(avatarKeyOf(p))" />
                <span v-else>{{ (p.name || '?').charAt(0) }}</span>
              </div>
              <div class="voice-peer-name">{{ p.isSelf ? (p.name || '我') + '（我）' : p.name }}</div>
              <div class="voice-peer-meta">
                <i :class="p.micOn ? 'ri-mic-line' : 'ri-mic-off-line'" />
                <span>{{ p.speaking ? '正在讲话' : p.micOn ? '语音已通' : '已静音' }}</span>
              </div>
            </div>
            <div v-if="!voiceRemotePeers.length" class="voice-waiting">
              <p>语音对讲已接通卫通云</p>
              <span>等待对方加入…</span>
            </div>
          </div>
        </div>

        <template v-if="!isVoiceMode">
        <!-- 三档排列统一按「成员」渲染（原型一格一人，没开摄像头的也占位）：
             宫格=平铺成员卡；顶部=缩略条 + 整幅主画面；右侧=只留主画面卡，成员缩进右侧 280 面板。 -->
        <!-- 顶部排列是「一条缩略条 + 一块主画面」上下两段：缩略条成员多到换行时，
             不能把主画面顶出舞台（实测三人时主画面被挤到 y=463，还按单行算高度）。
             所以成员按段分组渲染，瓦片模板只有一份；其余排列整组 display:contents 透明化。 -->
        <div
          v-for="(group, gi) in stageGroups"
          :key="'g' + gi"
          class="im-stage-group"
          :class="[gi === 0 ? 'im-stage-strip' : 'im-stage-main-row', { 'is-contents': layout !== 'top' }]"
        >
        <div
          v-for="r in group"
          :key="r.key"
          class="im-tile"
          :class="{ 'im-tile-self': r.isSelf, 'im-tile-main': layout === 'top' && !r.strip, 'im-tile-strip': !!r.strip, 'is-inmain': !!r.inMain, focused: focusKeyOf(r) !== '' && focusKeyOf(r) === focusedId, 'im-tile-share': !!r.streamId && r.streamId === shareStreamId }"
          @click="rowClick(r)"
        >
          <!-- 第4项：有可播视频流就出画面，没有视频（未开摄像头/无 active publication）才居中头像。
               缩略条里"此刻占着主画面"那一格是同一位的镜像格：镜像主画面那块画布/本地预览流，
               不给同一路流建第二个解码器（实测同流订两条通路就是自己打自己后端的下行）。 -->
          <!-- 船端局域网 WHEP 的那一路：画面直接绑在接收流上，不经画布（它没有取流→解帧→画布那一段）。
               镜像格与主格共用同一个 MediaStream，浏览器只解一次。 -->
          <video
            v-if="r.streamId && lanWhepVideo[r.streamId]"
            class="im-video"
            autoplay
            playsinline
            muted
            :srcObject="lanWhepVideo[r.streamId]"
          />
          <canvas
            v-else-if="r.streamId && !(r.strip && r.inMain)"
            :ref="(el) => setCanvasRef(r.streamId, el as HTMLCanvasElement | null)"
            class="im-video"
          />
          <canvas
            v-else-if="r.streamId && r.strip && r.inMain"
            :ref="(el) => setMirrorRef(r.streamId, el as HTMLCanvasElement | null)"
            class="im-video"
          />
          <!-- 共享中：本端主画面优先显示屏幕轨，不回落到摄像头人像。 -->
          <video
            v-else-if="!r.strip && r.isSelf && sharing && shareStream"
            class="im-video"
            autoplay
            playsinline
            muted
            :srcObject="shareStream"
          />
          <video
            v-else-if="!r.strip && r.isSelf"
            :ref="(el) => setSelfRef(el)"
            v-show="selfVideoLive"
            class="im-video"
            autoplay
            playsinline
            muted
            :style="selfStyle"
          />
          <video
            v-else-if="r.strip && r.isSelf && sharing && shareStream"
            class="im-video"
            autoplay
            playsinline
            muted
            :srcObject="shareStream"
          />
          <video
            v-else-if="r.strip && r.isSelf && selfVideoLive"
            class="im-video"
            autoplay
            playsinline
            muted
            :srcObject="selfStream"
            :style="selfStyle"
          />
          <div v-if="showAvatar(r)" class="im-tile-avatar">
            <img v-if="tileAvatarSrc(r)" :src="tileAvatarSrc(r)" :alt="r.name" @error="markAvatarBroken(avatarKeyOf(r))" />
            <span v-else class="im-tile-avatar-char">{{ (r.name || '?').charAt(0) }}</span>
            <p v-if="r.hint" class="im-tile-avatar-hint">{{ r.hint }}</p>
          </div>
          <!-- 第3项：两种 bar 分离——主画面窗格只挂悬浮统计条、不渲染格底状态栏；
               缩略条/宫格等非主画面窗格只渲染格底状态栏。 -->
          <div v-if="!isMainTile(r)" class="im-tile-foot">
            <div class="im-tile-line">
              <span class="im-tile-name">{{ r.name }}</span>
              <span v-if="r.nodeType" class="im-chip" :class="r.nodeType === 'edge' ? 'im-chip-edge' : 'im-chip-cloud'">
                {{ r.nodeType === 'edge' ? '边' : '云' }}
              </span>
              <span v-if="r.isHost && !r.strip" class="im-chip im-chip-host">主持人</span>
              <span v-if="r.speaking && !r.strip" class="im-chip im-chip-speak">正在讲话</span>
              <span class="im-tile-media">
                <i :class="r.micOn ? 'ri-mic-line' : 'ri-mic-off-line'" :title="r.micOn ? '麦克风已开' : '麦克风已关'" />
                <i :class="r.cameraOn ? 'ri-vidicon-line' : 'ri-video-off-line'" :title="r.cameraOn ? '摄像头已开' : '摄像头已关'" />
              </span>
            </div>
            <!-- 原型顶部排列的缩略条（15/16_meeting_top*.png）这一行是**带标签的两列**
                 「总上行速率 / 1.25 Mbps」，宫格与成员面板才是「↑1.25Mbps ↓3.82Mbps」。
                 宫格那一行后面还跟着这路的分辨率与帧率（摄像头关了则标「仅音频」）。 -->
            <div v-if="r.strip" class="im-tile-rate">
              <span class="im-rate-col"><i>总上行速率</i><b>{{ measuredRateText(r.upKbps) }}</b></span>
              <span class="im-rate-col"><i>总下行速率</i><b>{{ measuredRateText(r.downKbps) }}</b></span>
            </div>
            <div v-else class="im-tile-rate">
              <span>↑{{ rateTextCompact(r.upKbps) }}</span><span>↓{{ rateTextCompact(r.downKbps) }}</span>
              <em v-if="layout === 'grid' && !r.isSelf && specText(r)" class="im-tile-spec">{{ specText(r) }}</em>
            </div>
            <!-- 采不到轨（设备被占用）是真故障，要盖在名牌上说清楚，别装作黑帧正常。 -->
            <span v-if="r.isSelf && selfIssueText" class="im-off">{{ selfIssueText }}</span>
            <span v-else-if="r.error" class="im-off">{{ r.error }}</span>
          </div>
          <div v-if="r.speaking" class="im-speaking" />
          <div v-if="isMainTile(r) && (focusStat || focusedIsSelf)" class="im-statbar" :class="{ open: statBarOpen }">
            <template v-if="focusedIsSelf">
              <div class="im-statbar-item"><span class="k">本端媒体上行</span><span class="v">{{ uplinkText }}</span></div>
              <div class="im-statbar-item"><span class="k">本端媒体下行</span><span class="v">{{ downlinkText }}</span></div>
            </template>
            <template v-else>
              <div class="im-statbar-item"><span class="k">参会者</span><span class="v">{{ focusName }}</span></div>
              <div class="im-statbar-item"><span class="k">分辨率</span><span class="v">{{ focusResolution }}</span></div>
              <div class="im-statbar-item"><span class="k">接收帧率</span><span class="v">{{ focusFps }}</span></div>
              <div class="im-statbar-item"><span class="k">视频实收</span><span class="v">{{ measuredRateText(videoDown[statStreamId]) }}</span></div>
              <div class="im-statbar-item" :title="focusDelayTitle"><span class="k">相对帧延迟</span><span class="v">{{ focusDelayText }}</span></div>
              <div class="im-statbar-item" :title="focusAvSyncTitle"><span class="k">播放音画差</span><span class="v">{{ focusAvSyncText }}</span></div>
            </template>
          </div>
        </div>
        </div><!-- /im-stage-group -->

        <!-- 原型宫格末尾的「空位-邀请成员」格。原型副标题是「宫格还有 1 个空位 · 可再邀请 9 人」，
             但"能邀请到几个人"要的是会议室人数上限 —— 上游和本库都没有这个字段，
             没有真源就不写（宁可少一行字，也不摆一个编出来的数）。这里只报实测得到的人数。 -->
        <div v-if="layout === 'grid'" class="im-tile im-tile-invite">
          <span class="im-invite-ic"><i class="ri-user-add-line" /></span>
          <b class="im-invite-title">邀请成员加入</b>
          <span class="im-invite-sub">已加入 {{ joinedRows.length }} 人</span>
          <button class="im-invite-btn" @click="copyInviteLink">复制邀请信息</button>
        </div>

        <div v-if="!stageRows.length && !stageNotice" class="im-stage-hint">
          {{ isShareMode ? '请选择要共享的窗口或屏幕' : '远端画面来自会议链路的已发布流；当前还没有人发布视频' }}
        </div>
        <div v-else-if="stageNotice" class="im-stage-hint">{{ stageNotice }}</div>
        </template>
      </main>

      <MemberPanel
        v-if="panelVisible"
        :rows="panelRows"
        :active-key="mainRow ? mainRow.key : ''"
        :register-canvas="setCanvasRef"
        :self-stream="selfStream"
        :net-text="netText"
        :net-title="netTitle"
        :net-level="netLevel"
        @close="closeMembers"
        @invite="showInvite = true"
        @focus="focusRow"
      />

      <ChatPanel
        v-if="dock === 'chat'"
        v-model:draft="chatDraft"
        :messages="messages"
        :participants="participants"
        :my-name="myName"
        :started-at="meetingStore.state?.startedAt || ''"
        :share-of="sharingName"
        @close="dock = 'none'"
        @send="sendChat"
        @not-wired="onNotWired"
      />

      <!-- 传输状态：对齐三方会中面板，全部来自播放器/ getStats 真实回调；无真源的字段留空不造假 -->
      <aside v-if="dock === 'stats'" class="im-dock im-stats">
        <header class="im-dock-head"><b>传输状态</b><button class="im-x" title="关闭" @click="dock = 'none'"><i class="ri-close-line" /></button></header>
        <div class="im-stats-body">
          <div class="im-stats-grid" aria-label="本端带宽">
            <div><span class="k">本端媒体上行</span><span class="v" data-rate="up">{{ uplinkText }}</span></div>
            <div><span class="k">本端媒体下行</span><span class="v" data-rate="down">{{ downlinkText }}</span></div>
          </div>
          <VideoPathStatus v-if="statsLine" v-model="selectedStatsId" :streams="publicLines" :selected="statsLine" :self-id="myId" />
          <div v-else-if="focusSourceStream?.video && !focusSourceStream.transportMode && !focusSourceStream.videoStats" class="im-stats-row">
            <span class="k">压缩比</span><span class="v">{{ legacyCompressionRatio }}</span>
          </div>
        </div>
      </aside>
    </div>

    <!-- 腾讯会议风格：共享中悬浮条 —— 一眼看到正在共享什么，一键停止 -->
    <div v-if="sharing" class="share-float" role="status">
      <div class="share-float-preview">
        <video v-if="shareStream" class="share-float-video" autoplay playsinline muted :srcObject="shareStream" />
        <i v-else class="ri-computer-line" />
      </div>
      <div class="share-float-copy">
        <b>正在共享屏幕</b>
        <span>{{ shareTrackLabel }}</span>
      </div>
      <button class="share-float-stop" type="button" @click="toggleShare">停止共享</button>
    </div>

    <footer :inert="!admitted" class="im-controls">
      <div class="im-ctl-center">
        <!-- 主控：麦 / 视频 /（桌面共享）—— 窄屏只留参会必需，其余进「更多」 -->
        <button class="im-btn" :class="{ 'im-btn-off': !micOn }" @click="toggleMic">
          <i :class="micOn ? 'ri-mic-line' : 'ri-mic-off-line'" /><span>{{ micOn ? '静音' : '开麦' }}</span>
        </button>
        <button
          v-if="!isVoiceMode"
          class="im-btn"
          :class="{ 'im-btn-off': !cameraOn, 'im-btn-on': isShareMode && sharing }"
          @click="toggleCamera"
        >
          <i :class="cameraOn ? 'ri-vidicon-line' : 'ri-video-off-line'" /><span>{{ cameraOn ? '关视频' : '开视频' }}</span>
        </button>
        <button
          v-if="!isCompact"
          class="im-btn"
          :class="{ 'im-btn-on': sharing, 'im-btn-primary-share': isShareMode && !sharing }"
          @click="toggleShare"
        >
          <i class="ri-airplay-line" /><span>{{ sharing ? '停止共享' : '共享屏幕' }}</span>
        </button>
        <button v-if="!isCompact" class="im-btn" @click="showInvite = true"><i class="ri-user-add-line" /><span>邀请</span></button>
        <button v-if="!isCompact" class="im-btn" :class="{ 'im-btn-on': panelVisible }" @click="toggleDock('members')">
          <i class="ri-group-line" /><span>成员({{ participants.length }})</span>
        </button>
        <button v-if="!isCompact" class="im-btn" :class="{ 'im-btn-on': dock === 'chat' }" @click="toggleDock('chat')">
          <i class="ri-chat-3-line" /><span>聊天{{ messages.length ? '(' + messages.length + ')' : '' }}</span>
        </button>
        <button v-if="!isCompact" class="im-btn" :class="{ 'im-btn-on': dock === 'stats' }" @click="toggleDock('stats')">
          <i class="ri-signal-tower-line" /><span>传输状态</span>
        </button>
        <button v-if="!isCompact" class="im-btn" :class="{ 'im-btn-on': isLocalRecording }" :title="localRecordTitle" @click="rsToggle().then(handleRecordResult)">
          <i :class="isLocalRecording ? 'ri-record-circle-fill' : 'ri-record-circle-line'" /><span>{{ isLocalRecording ? '停止本地录制' : '本地录制' }}</span>
        </button>
        <button
          v-if="!isCompact && assistant?.state?.host"
          :aria-label="cloudRecording ? '停止云录制' : '开启云录制'"
          class="im-btn"
          :class="{ 'im-btn-on': cloudRecording }"
          :title="boardRecordingHint"
          @click="toggleCloudRecord"
        >
          <i class="ri-cloud-line" /><span>{{ cloudRecording ? '停止云录制' : '开启云录制' }}</span>
        </button>

        <button v-if="!isCompact" class="im-btn" :class="{ 'im-btn-on': captionsOn }" :aria-pressed="captionsOn" :disabled="assistant?.working" @click="assistant?.toggleSpeech()"><i class="ri-translate-2" /><span>转录与翻译</span></button>
        <button v-if="!isCompact" class="im-btn" @click="openAssistant('materials')"><i class="ri-file-list-3-line" /><span>会议助手</span></button>
        <!-- 窄屏：成员 + 更多（邀请/聊天/共享/录制/设置） -->
        <button
          v-if="isCompact"
          class="im-btn"
          :class="{ 'im-btn-on': panelVisible }"
          @click="toggleDock('members')"
        >
          <i class="ri-group-line" /><span>成员</span>
        </button>
        <el-dropdown v-if="isCompact" trigger="click" @command="onMoreCommand">
          <button class="im-btn" :class="{ 'im-btn-on': dock === 'chat' || dock === 'stats' || sharing || isLocalRecording || cloudRecording }">
            <i class="ri-more-fill" /><span>更多</span>
          </button>
          <template #dropdown>
            <el-dropdown-menu class="im-more-menu">
              <el-dropdown-item command="captions"><i class="ri-translate-2" /> {{ captionsOn ? '关闭转录与翻译' : '转录与翻译' }}</el-dropdown-item>
              <el-dropdown-item command="assistant"><i class="ri-file-list-3-line" /> 会议助手</el-dropdown-item>
              <el-dropdown-item command="invite"><i class="ri-user-add-line" /> 邀请</el-dropdown-item>
              <el-dropdown-item command="chat"><i class="ri-chat-3-line" /> 聊天{{ messages.length ? ` (${messages.length})` : '' }}</el-dropdown-item>
              <el-dropdown-item command="share"><i class="ri-airplay-line" /> {{ sharing ? '停止共享' : '共享屏幕' }}</el-dropdown-item>
              <el-dropdown-item command="stats"><i class="ri-signal-tower-line" /> 传输状态</el-dropdown-item>
              <el-dropdown-item command="local-rec" divided>
                <i :class="isLocalRecording ? 'ri-record-circle-fill' : 'ri-record-circle-line'" />
                {{ isLocalRecording ? '停止本地录制' : '本地录制' }}
              </el-dropdown-item>
              <el-dropdown-item v-if="assistant?.state?.host" command="cloud-rec">
                <i class="ri-cloud-line" />
                {{ cloudRecording ? '停止云录制' : '开启云录制' }}
              </el-dropdown-item>
              <el-dropdown-item v-if="isPhone" command="settings" divided><i class="ri-settings-3-line" /> 设置</el-dropdown-item>
              <el-dropdown-item v-if="isHost" command="end" divided><i class="ri-shut-down-line" /> 结束会议</el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
      </div>

      <div class="im-ctl-right">
        <button class="im-btn im-btn-leave" @click="leave">
          <i class="ri-logout-box-r-line" /><span>{{ isCompact ? '离开' : '离开会议' }}</span>
        </button>
        <button v-if="isHost && !isCompact" class="im-btn im-btn-end" @click="endAll"><i class="ri-shut-down-line" /><span>结束会议</span></button>
      </div>
    </footer>

    <MeetingAssistant ref="assistant" @leave="leave" v-model="showAssistant" :initial-tab="assistantTab" :meeting-id="meetingId" :number="String(meetingStore.meetingNo || '')" :stream="selfStream" :mic="micOn" in-meeting />
    <MeetingSettingsPopover v-model="showSettings" :apply-live="applyVideoDelivery" @changed="onPrefsChanged">
      <template #speech>
        <template v-if="assistant && assistant.state">
          <el-form-item label="字幕目标语言"><el-select v-model="assistant.target">
            <el-option v-for="(name,key) in assistant.state.languages" :key="key" :label="name" :value="key" />
          </el-select></el-form-item>
          <el-button link v-if="!assistant.state.voiceBound" :disabled="assistant.enrolling" @click="assistant.enroll()">{{ assistant.enrolling ? '请连续讲话 4 秒…' : '绑定我的声纹' }}</el-button>
          <el-button link v-else @click="assistant.removeVoice()">删除我的声纹</el-button>
          <h3>本场术语库</h3>
          <GlossarySettings :meeting-id="meetingId" :number="String(meetingStore.meetingNo || '')" :editable="assistant.state.host" />
        </template>
      </template>
    </MeetingSettingsPopover>
    <InviteMeetingDialog
      v-model="showInvite"
      :meeting-id="meetingId"
      :meeting-no="meetingStore.meetingNo"
      :title="meetingStore.title"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox, ElDropdown, ElDropdownMenu, ElDropdownItem } from 'element-plus'
import GlossarySettings from '@/components/meeting/GlossarySettings.vue'
import MeetingAssistant from '@/components/meeting/MeetingAssistant.vue'
import MeetingSettingsPopover from '@/components/dialogs/MeetingSettingsPopover.vue'
import InviteMeetingDialog from '@/components/dialogs/InviteMeetingDialog.vue'
import MemberPanel, { type MemberRow } from '@/components/panels/MemberPanel.vue'
import ChatPanel from '@/components/panels/ChatPanel.vue'
import {
  getMeetingState,
  getMeetingDetail,
  endMeeting,
  focusStream,
  reportMediaState,
  reportTelemetry,
  mediaUrl,
  type ParticipantVo,
  type StreamVo,
  type TelemetryItem,
} from '@/api/meeting'
import { getChatMessages } from '@/api/chat'
import { ApiError, get } from '@/utils/request'
import { avatarSrcFor, markAvatarBroken } from '@/utils/avatarImage'
import { ensureShareOrigin, inviteTextFor } from '@/utils/joinFlow'
import { copyText } from '@/utils/clipboard'
import { useMeetingStore } from '@/store/meeting'
import { useUserStore } from '@/store/user'
import { useWebSocket } from '@/composables/useWebSocket'
import { acquireMicrophoneTrack, useMediaSettings } from '@/composables/useMediaSettings'
import { useViewport } from '@/composables/useViewport'
import { useFaceEnhancement } from '@/composables/useFaceEnhancement'
import { useWhipPublish, describePublishError } from '@/composables/useWhipPublish'
import { useSpeaking } from '@/composables/useSpeaking'
import {
  isLocalRecording, recTrackCount, toggleLocalRecord as rsToggle, stopLocalRecord as rsStop,
  registerRecordingProviders, unregisterRecordingProviders,
  setRemoteAudioStream, cleanupDeadAudioStreams, getRemoteAudioStream,
  type DesiredTrack,
} from '@/utils/recordingSession'
import VideoPathStatus from '@/components/VideoPathStatus.vue'
import { compressionView, fpsText, measuredRateText, pickTransmittedKbps, rateTextCompact } from '@/utils/compression'
import type { BrowserVideoSample } from '@/utils/videoObservations'
import { findAudioMateId } from '@/utils/avMate'
import { loadMediaPlayer, authHeaders, type MediaPlayer, type MediaStreamPlayer, type MediaFrame } from '@/utils/mediaPlayer'
import {
  subscribeWhepAudio, subscribeWhepVideo, whepSubscribePath, observeVideoFirstFrame, observeFrameTimes,
  SubscribeError, type WhepPlayer, type WhepStats,
} from '@/utils/whepPlayer'
import { FrameDriftMeter } from '@/utils/mediaClock'
import { parseFrameTimes, captureEpochMsFor, type FrameTimesSnapshot } from '@/utils/frameTimes'
import { classifyStreamFailure, type StreamFailure } from '@/utils/streamFailure'
import { classifyPublish, publishLabel as publishLabelOf } from '@/utils/publishState'
import { probeNetwork, gradeNet, type NetProbe } from '@/utils/mediaTest'

type LayoutId = 'top' | 'grid' | 'right'
type DockId = 'none' | 'members' | 'chat' | 'stats'
import { readDelivery, type VideoDelivery, type VideoKind } from '@/utils/videoDelivery'
import { setVideoDelivery } from '@/api/meeting'

/** 浏览器 WHEP 视频腿：船内 lanWhep + 公网会议 cloudWhep 共用同一套播放器路径。 */
function isWhepVideoChannel(ch?: string | null) {
  return ch === 'lanWhep' || ch === 'cloudWhep'
}

// 自己的预览没有流号，用哨兵值占住"聚焦"这一格。
const SELF_FOCUS = '__self__'

const route = useRoute()
const router = useRouter()
const meetingStore = useMeetingStore()
const userStore = useUserStore()
const ws = useWebSocket()
const media = useMediaSettings()
const { isPhone, isTablet, isCompact } = useViewport()
const faceRoi = useFaceEnhancement()
const whip = useWhipPublish(() => meetingId)
// 屏幕共享必须用独立的发布实例：useWhipPublish 单实例 publish() 会先 unpublish() 关掉上一条，
// 复用 whip 会让"开共享"把摄像头发布一起顶掉。后端 publications 按 mediaKind 分轨、各自去重。
const whipScreen = useWhipPublish(() => meetingId)
// 三方逆向（meeting.js restartMicrophonePublication）：麦克风是**独立的 mediaKind:'audio' WHIP 发布**，
// 不跟 camera 捆在一条 RTCPeerConnection 里——捆绑的音轨三方媒体服务器不转发，对端听不见。
const whipAudio = useWhipPublish(() => meetingId)

const meetingId = Number(route.params.id || meetingStore.meetingId || 0)

const layouts: Array<{ value: LayoutId; label: string }> = [
  { value: 'top', label: '顶部排列' },
  { value: 'grid', label: '宫格排列' },
  { value: 'right', label: '右侧排列' },
]
// 原型布局切换键用 remixicon layout 系图标：每档一个形，别让文字下拉框冒充图标。
const LAYOUT_ICONS: Record<LayoutId, string> = {
  top: 'ri-layout-row-line',
  grid: 'ri-layout-grid-line',
  right: 'ri-layout-column-line',
}
const layout = computed({
  get: () => meetingStore.uiLayout,
  set: (v: LayoutId) => { meetingStore.uiLayout = v },
})
const layoutIcon = computed(() => LAYOUT_ICONS[layout.value])
const layoutLabel = computed(() => layouts.find((l) => l.value === layout.value)?.label || '')
function pickLayout(v: LayoutId) {
  layout.value = v
}

/** 手机竖屏强制宫格：顶部/右侧排列会把主画面压成一条。切回桌面后仍尊重用户上次选择。 */
watch(
  isPhone,
  (phone) => {
    if (phone && layout.value !== 'grid') layout.value = 'grid'
  },
  { immediate: true },
)

// 成员栏的位置归"排列"管：默认不额外挂出右侧面板，否则顶部排列下右边还杵着一列成员，
// 与原型（成员缩略条在舞台上方）不符。
const dock = computed({
  get: () => meetingStore.uiDock as DockId,
  set: (v: DockId) => { meetingStore.uiDock = v },
})
const showSettings = ref(false)
const showInvite = ref(false)
/** 共享入口只自动拉起一次屏幕采集，避免设置改动重采时再弹选择器。 */
let launchIntentApplied = false
const chatDraft = ref('')
const selfRef = ref<HTMLVideoElement | null>(null)
const streamRefs = new Map<string, HTMLVideoElement>()
const canvasRefs = new Map<string, HTMLCanvasElement>()
const videoPlayers = new Map<string, MediaStreamPlayer>()
// 播放器当前画的是哪块画布。托管播放器只在构造时认 canvas，画布换 DOM 节点后必须重建它。
const playerCanvases = new Map<string, HTMLCanvasElement>()
// 船端局域网 WHEP 那一腿的视频：播放器与它产出的 MediaStream 各记一份。
// 它没有"取流→解帧→画到画布"这一段，画面直接绑到那一格的 <video> 上。
const whepVideoPlayers = new Map<string, WhepPlayer>()
const lanWhepVideo = ref<Record<string, MediaStream>>({})
// 这一路"真出过一帧"的证据。没有它就不登录制路：零帧的轨只会录出一路凭空消失的缺口。
const lanWhepFramed = new Set<string>()
const lanWhepFrameWatch = new Map<string, () => void>()
// 帧级时刻的监视器（相对帧延迟的输入），与"等首帧"那份分开存：一个持续跑，一个出帧即撤。
const lanWhepTimeWatch = new Map<string, () => void>()
// 音频播放器有两种实现（订阅式与直连流式），共同点只有 stop()。
const audioPlayers = new Map<string, { stop: () => void; failed?: () => boolean }>()
// 每一路的**声音**最终走的是哪条腿：'whep'（浏览器 PC，能量到播放时刻）还是 'direct'（直连流，
// 没有 PC）。音画差要拿画面与声音两边的"播放时刻"相减，声音走直连时那个量结构上取不到 ——
// 与"还没收到数据"是两件事，必须分开说，否则这一格会永远显示"统计中"（用户会一直等）。
const audioLegKind = ref<Record<string, 'whep' | 'direct'>>({})
const streamError = ref<Record<string, string>>({})
const focusedId = ref('')
const stageNotice = ref('')
const selfStream = ref<MediaStream | null>(null)
const shareStream = ref<MediaStream | null>(null)
const cameraOn = ref(true)
const micOn = ref(true)
// 设备在但采不到轨（被占用/权限被撤）时的真实标记，用来把"没画面"说清楚而不是装作在推流。
const cameraMissing = ref(false)
const micMissing = ref(false)
// 第4项：本端那一格「有没有画面」必须问轨，不能问意图位。`cameraOn` 只是用户意图，
// 而摄像头被别的程序抢走时浏览器不报错、只把轨置 muted（一帧不出）——真机复验
// 「本端发布异常」那次主画面就是一块纯黑空框、连头像都不回落。
const selfVideoLive = ref(false)
let selfLiveCleanup: (() => void) | null = null
const sharing = ref(false)
const isFullscreen = ref(false)
const net = ref<(NetProbe & { label: string; level: string }) | null>(null)
let rateTimer: number | null = null
let netTimer: number | null = null
let retryTimer: number | null = null
let telemetryTimer: number | null = null

const participants = computed<ParticipantVo[]>(() => ws.participants.value)
const invited = computed(() => ws.invited.value)
const streams = computed<StreamVo[]>(() => ws.streams.value)
const messages = computed(() => ws.messages.value)
const myId = computed(() => meetingStore.participantId)

// 只有进行中的会才接受本端推流：三方对未开始的会议回"不在进行中"（实测预约会议），
// 已结束又会把会话判死。starting 也放行，那是主持人点了开始、状态还没追上的窗口。
const canPublish = computed(() => {
  const s = meetingStore.state?.status
  return s === 'running' || s === 'starting'
})
// 入会时会议还没开始：先记下"欠一次发布"，状态转可发布时补上，避免用户再手动开关一次。
let pendingSelfPublish = false
const myName = computed(() => meetingStore.self?.name || userStore.userInfo?.displayName || '我')
const isHost = computed(() => !!participants.value.find((p) => p.id === myId.value)?.isHost)
// 自己的发布不订阅：否则会出现一个永远黑屏的"自己"窗格（实测出现过）。
// 瓦片只挂带视频的流；独立 audio 发布按三方惯例作为"伴随音频"订阅播放，不占一格。
const remoteStreams = computed(() =>
  subscribableStreams.value.filter(s => s.video),
)
// 别人共享出来的那一路屏幕流：原型「共享屏幕中」要把它顶成主画面。
const shareStreamId = computed(() => remoteStreams.value.find((s) => s.kind === 'screen')?.id || '')
const subscribableStreams = computed(() =>
  myId.value ? streams.value.filter(s => (s.video || s.audio) && s.ownerId && s.ownerId !== myId.value) : [],
)

// 原型三档排列里成员的位置由**排列**决定，不由一个独立开关决定：
// 右侧排列 = 左主画面卡 + 右一列 280 独立成员面板；顶部排列 = 缩略条在上、整幅主画面在下；
// 宫格排列 = 成员即格子，不另设成员栏。
const railOpen = ref(true)
const showMemberRail = computed(() => layout.value === 'right' && railOpen.value)
const panelVisible = computed(() => showMemberRail.value || dock.value === 'members')
function closeMembers() {
  if (layout.value === 'right') railOpen.value = false
  dock.value = 'none'
}

// 每个成员的下行 = 本端接收其各路流的播放器实测速率之和；上行只有"我自己"才有真源，
// 对方上行本端测不到，一律给 — 而不是编一个数。
const memberDownKbps = computed<Record<string, number>>(() => {
  const m: Record<string, number> = {}
  for (const s of subscribableStreams.value) {
    const r = (videoDown.value[s.id] ?? 0) + (audioDown.value[s.id] ?? 0)
    if (s.active && (videoDown.value[s.id] != null || audioDown.value[s.id] != null)) m[s.ownerId] = (m[s.ownerId] || 0) + r
  }
  return m
})

// 每人取一路可显示的视频流：正在共享的屏幕优先（原型里共享者那一格就是共享画面）。
function streamOfMember(id: string): StreamVo | null {
  return (
    remoteStreams.value.find((s) => s.ownerId === id && s.kind === 'screen') ||
    remoteStreams.value.find((s) => s.ownerId === id) ||
    null
  )
}

const joinedRows = computed<MemberRow[]>(() =>
  participants.value.map((p) => {
    const isSelf = p.id === myId.value
    const stream = isSelf ? null : streamOfMember(p.id)
    return {
      key: p.id,
      name: p.name,
      avatar: p.avatar || '',
      isSelf,
      isHost: p.isHost,
      nodeType: p.nodeType,
      joined: true,
      // 本端那一格以本机状态为准：三方状态说的是"这条发布还在不在"，而静音/关视频是**拆流重建**，
      // 快照里旧发布还会留一阵 —— 拿它画本端，就会出现"按钮已静音、格子里麦克风还开着"。
      // 对端那一格没有本机意图可依据，仍只能按真实发布画。
      micOn: isSelf ? micOn.value : p.micOn,
      cameraOn: isSelf ? cameraOn.value : p.cameraOn,
      speaking: isSelf ? speakingSelf.value || !!ws.speakingMap.value[p.id] : !!ws.speakingMap.value[p.id],
      streamId: stream?.id || '',
      thumb: 'avatar' as const,
      // 原型里"摄像头开着但这一路还没画面"就是一块纯头像（李四那一格），没有说明文字；
      // 只有真关掉了才标「摄像头已关闭」。原先自己那格恒被判成"尚未发布视频"——
      // 本端画面走本地预览、不进 remoteStreams，所以 isSelf 的 stream 一直是 null。
      hint: (isSelf ? cameraOn.value : p.cameraOn) ? '' : '摄像头已关闭',
      error: stream ? streamError.value[stream.id] || '' : '',
      upKbps: isSelf ? uplinkKbps.value : null,
      downKbps: isSelf ? downlinkKbps.value : memberDownKbps.value[p.id] ?? null,
    }
  }),
)

// 等候入场 = 受邀但未出现在在线成员里。后端已用三方账号/姓名比对好，前端不再猜。
const waitingRows = computed<MemberRow[]>(() =>
  invited.value
    .filter((i) => !i.joined)
    .map((i) => ({
      key: 'inv_' + i.userId,
      name: i.name,
      // 等候入场那批也是真人：头像走后端 invited[].avatar（sys_user 派生的 API 路径），
      // 没传过头像才空着由模板兜底成首字 —— 之前这里写死 ''，等于让受邀者永远拿不到自己上传的头像。
      avatar: i.avatar || '',
      isSelf: false,
      isHost: false,
      nodeType: '',
      joined: false,
      micOn: false,
      cameraOn: false,
      speaking: false,
      streamId: '',
      thumb: 'avatar' as const,
      hint: '',
      error: '',
      upKbps: null,
      downKbps: null,
    })),
)

// 右侧排列的主画面：聚焦那路优先，其次自己，再取第一位成员（原型只有一块主画面卡）。
const mainRow = computed<MemberRow | null>(() => {
  const rows = joinedRows.value
  return (
    rows.find(
      (r) => (r.streamId && r.streamId === focusedId.value) || (r.isSelf && focusedId.value === SELF_FOCUS),
    ) ||
    rows.find((r) => r.isSelf) ||
    rows[0] ||
    null
  )
})

const stageRows = computed<MemberRow[]>(() => {
  if (layout.value === 'right') return mainRow.value ? [mainRow.value] : []
  if (layout.value !== 'top') return joinedRows.value
  // 原型顶部排列（15_meeting_top2.png）：上面一条等宽缩略条**包含主画面那位**（那一格带蓝描边），
  // 下面才是整幅主画面。原先只把主画面那位从缩略条里省掉，两人会议就变成"一小一大"，
  // 和原型的"一排成员卡 + 一块主画面"不是一回事。
  const main = mainRow.value
  const strip = joinedRows.value.map((r) => ({
    ...r,
    key: 'strip_' + r.key,
    strip: true,
    inMain: !!main && main.key === r.key,
  }))
  return main ? [...strip, { ...main }] : strip
})

// 顶部排列分两段渲染（缩略条 / 主画面），其余排列整组交给舞台自己排。
const stageGroups = computed<MemberRow[][]>(() => {
  const rows = stageRows.value
  if (layout.value !== 'top') return [rows]
  return rows.length ? [rows.slice(0, -1), [rows[rows.length - 1]]] : []
})

// 只有右侧排列展开面板时，成员缩略图才挂面板 canvas；主画面已占用的那路流不能有第二个解码器。
// 自己那格例外：它放的是本地预览（srcObject 直接指到采集流），不占解码器，
// 原型里主画面是张三时、成员栏张三那一格也是同一张画面。
const panelRows = computed<MemberRow[]>(() => {
  const rows = [...joinedRows.value, ...waitingRows.value].map((r) => ({ ...r }))
  if (layout.value === 'right' && railOpen.value) {
    for (const r of rows) {
      if (r.isSelf) {
        if (selfStream.value && cameraOn.value) r.thumb = 'self'
        continue
      }
      if (mainRow.value && r.key === mainRow.value.key) continue
      // 面板里那块画布只有"直连那条腿"才会往上面画：局域网那条腿的画面在接收流上，
      // 订上了就绑 <video>、还没订上就退回头像，两种情况都不留一块没人画的画布。
      if (r.streamId && isWhepVideoChannel(streamOfMember(r.key)?.videoChannel)) {
        const received = lanWhepVideo.value[r.streamId]
        if (received) {
          r.thumb = 'stream'
          r.thumbStream = received
        }
        continue
      }
      if (r.streamId) r.thumb = 'canvas'
    }
  }
  return rows
})

// 缩略条里主画面那位的镜像格画布：不另建解码器，rAF 把主画面画布逐帧复制过来。
const mirrorRefs = new Map<string, HTMLCanvasElement>()
function setMirrorRef(id: string, el: HTMLCanvasElement | null) {
  if (el) {
    mirrorRefs.set(id, el)
    startMirrorLoop()
    return
  }
  const cur = mirrorRefs.get(id)
  if (cur && !cur.isConnected) mirrorRefs.delete(id)
}
let mirrorRaf = 0
function stopMirrorLoop() {
  if (mirrorRaf) cancelAnimationFrame(mirrorRaf)
  mirrorRaf = 0
}
function startMirrorLoop() {
  if (mirrorRaf) return
  const step = () => {
    for (const [id, el] of [...mirrorRefs]) {
      if (!el.isConnected) {
        if (mirrorRefs.get(id) === el) mirrorRefs.delete(id)
        continue
      }
      const src = canvasRefs.get(id)
      if (!src || !src.width || !src.height) continue
      if (el.width !== src.width || el.height !== src.height) {
        el.width = src.width
        el.height = src.height
      }
      el.getContext('2d')?.drawImage(src, 0, 0)
    }
    mirrorRaf = mirrorRefs.size ? requestAnimationFrame(step) : 0
  }
  mirrorRaf = requestAnimationFrame(step)
}

function focusKeyOf(r: MemberRow) {
  return r.isSelf ? SELF_FOCUS : r.streamId
}

// 第3项（两种 bar 分离）的"主画面窗格"判据：
// 顶部/右侧排列就是那块主画面格；宫格没有独立主画面，聚焦那一格充当主画面。
function isMainTile(r: MemberRow): boolean {
  if (r.strip) return false
  if (layout.value === 'grid') {
    const k = focusKeyOf(r)
    return k !== '' && k === focusedId.value
  }
  return true
}

// 第4项：该位有可播画面（远端流瓦片、或本端预览）就不出头像；没有视频才居中显示头像。
function showAvatar(r: MemberRow): boolean {
  if (r.streamId) return false
  // 本端正在共享：主画面已经是屏幕轨，别再盖头像。
  if (r.isSelf && sharing.value && shareStream.value) return false
  if (r.isSelf) return !selfVideoLive.value
  return true
}

/**
 * 重新问一次本端轨的真实状态。判据是「这条轨现在出不出画面」，不是「用户想不想开摄像头」，
 * 也不是「推没推得出去」——发布失败时本地画面照样该显示。
 */
function refreshSelfVideoLive() {
  const track = selfStream.value?.getVideoTracks().find((t) => t.readyState === 'live') ?? null
  selfVideoLive.value = !!track && track.enabled && !track.muted
}

/**
 * 摄像头被别的程序抢走时 Chromium 不报错，只把轨置 muted（一帧不出）；抢回来时 unmute，
 * 拔设备时 ended。这三个事件就是「有没有画面」的唯一真源，所以不需要再挂轮询去猜。
 * 换流（重采集/切设备）时旧轨的事件随旧流一起丢，先解绑再绑新的。
 */
function bindSelfVideoLiveEvents(stream: MediaStream) {
  selfLiveCleanup?.()
  selfLiveCleanup = null
  const track = stream.getVideoTracks()[0]
  if (!track) return
  const sync = () => refreshSelfVideoLive()
  track.addEventListener('mute', sync)
  track.addEventListener('unmute', sync)
  track.addEventListener('ended', sync)
  selfLiveCleanup = () => {
    track.removeEventListener('mute', sync)
    track.removeEventListener('unmute', sync)
    track.removeEventListener('ended', sync)
  }
}

/**
 * 头像取不到时回落到首字占位，不留空白圆圈 —— 口径见 utils/avatarImage 的 avatarSrcFor，
 * 与设置页/预入会页的 avatarBroken 兜底同一条路（坏的是"这个人"的图，键就是这个人）。
 */
function avatarKeyOf(r: MemberRow): string {
  return r.key || r.name
}
function tileAvatarSrc(r: MemberRow): string {
  return avatarSrcFor(avatarKeyOf(r), r.avatar)
}

function specText(r: MemberRow) {
  if (!r.cameraOn) return '摄像头关闭 · 仅音频'
  const st = r.streamId ? streamStats.value[r.streamId] : null
  return st && st.w && st.h ? `${st.w}×${st.h}p · ${Math.round(st.fps)} fps` : ''
}

function rowClick(r: MemberRow) {
  if (r.isSelf) focusSelf()
  else if (r.streamId) void focus(r.streamId)
}

function focusRow(key: string) {
  const r = joinedRows.value.find((x) => x.key === key)
  if (r) rowClick(r)
}

// 宫格「空位-邀请成员」格：复制邀请全文（主题/时间/可分享链接）；会议号只在链接路径里，粘贴回首页可解析。
async function copyInviteLink() {
  const no = meetingStore.meetingNo || ''
  if (!no) {
    ElMessage.warning('会议号尚未就绪，暂时拼不出邀请信息')
    return
  }
  await ensureShareOrigin()
  let hostName = userStore.userInfo?.displayName || ''
  let startTime = meetingStore.state?.startedAt || ''
  let durationMinutes = 0
  try {
    if (meetingId) {
      const m = (await getMeetingDetail(meetingId)).data
      if (m) {
        hostName = m.hostName || m.creatorName || hostName
        startTime = m.startTime || m.startedAt || startTime
        durationMinutes = m.durationMinutes || 0
      }
    }
  } catch {
    /* 详情失败仍用会中已有字段拼邀请 */
  }
  const text = inviteTextFor({
    hostName,
    title: meetingStore.title,
    meetingNo: no,
    startTime,
    durationMinutes,
  })
  if (!text) {
    ElMessage.warning('会议号尚未就绪，暂时拼不出邀请信息')
    return
  }
  const ok = await copyText(text)
  if (ok) ElMessage.success('邀请信息已复制')
  else ElMessage.error('复制失败，请长按选中后手动复制')
}

// 采不到轨是真故障，盖在名牌上说清楚；其余"没画面"由头像格自行提示。
const selfIssueText = computed(() =>
  cameraMissing.value ? '未采集到画面（设备可能被占用）' : micMissing.value ? '未采集到声音' : '',
)

const netText = computed(() => (net.value ? net.value.label + ' · ' + net.value.rttMs + 'ms' : '检测中'))
const netLevel = computed(() => net.value?.level || '')

const assistant = ref<InstanceType<typeof MeetingAssistant> | null>(null)
const admitted = ref(false)
const cloudRecording = computed(() => !!assistant.value?.state?.capture)
const captionsOn = computed(() => !!assistant.value?.state?.transcription.enabled)
const boardRecordingHint = '主持人控制加密云录制'
const assistantTab = ref('materials')
const showAssistant = ref(false)
function openAssistant(tab: string) { assistantTab.value = tab; showAssistant.value = true }
const sharingName = computed(() => participants.value.find((p) => p.sharing)?.name || '')
const shareTrackLabel = computed(() => {
  const label = shareStream.value?.getVideoTracks()[0]?.label || ''
  return label ? label.slice(0, 48) : '你的屏幕画面已推送给参会者'
})

// 上下行速率全部本地实测：上行取 RTCPeerConnection.getStats 的 outbound-rtp 字节增量，
// 下行取三方播放器回吐的接收速率。平台不提供任何码率统计端点。
const cameraUpKbps = ref(0)
const micUpKbps = ref(0)
const screenUpKbps = ref(0)
// 实测帧率（outbound-rtp 的 framesPerSecond）。此前上报遥测时这一位硬写 0，
// 而这个数就在算码率的同一个 getStats report 里 —— 三方 `samplePeerRates` 也是取它。
const cameraSample = ref<BrowserVideoSample | null>(null)
const screenSample = ref<BrowserVideoSample | null>(null)
const cameraFps = ref(0)
const screenFps = ref(0)
const uplinkKbps = computed(() => (cameraOn.value ? cameraUpKbps.value : 0) + (micOn.value ? micUpKbps.value : 0) + (sharing.value ? screenUpKbps.value : 0))
// 速率文本一律走 `rateText`（`utils/compression.ts`，全仓唯一的 kbps→Mbps 换算处）。
// 此前本文件与 MainLayout 各有一份 `toFixed(0) + ' kbps'`，于是**同一个数**在顶栏是
// 「384 kbps」、在同一张会议信息卡里是「384.15 kbps」—— 用户会当成两个数。
const uplinkText = computed(() => measuredRateText(uplinkKbps.value))

const statusLabel = computed(() => {
  const s = meetingStore.state?.status
  if (!s) return ws.connected.value ? '连接中' : '未连接'
  const map: Record<string, string> = {
    scheduled: '待开始', starting: '启动中', running: '进行中',
    ended: '已结束', cancelled: '已取消', failed: '失败',
  }
  return map[s] || s
})
const statusClass = computed(() => (meetingStore.state?.status === 'running' ? 'im-badge-run' : 'im-badge-idle'))
const publishState = ref('')
const screenPublishState = ref('')
// 判据与 title 同源（`utils/publishState.ts`）：以前这里是 `=== 'connected'`，
// 于是"从没回调过状态"和"正在建立"也被挂上"本端发布异常"，而同一状态下 title 写着"未推流"。
const publishFaulty = computed(() => classifyPublish(publishState.value) === 'fault')
const publishLabel = computed(() => publishLabelOf(publishState.value))
const wsOk = computed(() => ws.connected.value)
// 断开多久才升"已断开"由 useWebSocket 定（它才握着重连退避的真实节奏），这里只读结果。
const wsLost = computed(() => ws.degraded.value)
const netTitle = computed(() =>
  net.value?.ok
    ? `到本系统后端的实测往返（${net.value.samples} 次采样中位数），不代表卫星链路质量`
    : '网络探测失败',
)

const selfStyle = computed(() => ({
  transform: media.prefs.value?.mirrorVideo ? 'scaleX(-1)' : '',
}))

const { speakingSelf, start: startSpeaking, stop: stopSpeaking } = useSpeaking()

function setCanvasRef(id: string, el: HTMLCanvasElement | null) {
  if (el) {
    canvasRefs.set(id, el)
    return
  }
  // 卸载回调可能排在新挂载回调之后（这一路从成员栏搬进主画面时两边会交错），
  // 无条件 delete 会把刚登记的新画布又抹掉 —— 于是这一路再也找不到画布，
  // 而老播放器还抱着已脱离文档的那块画布，表现就是"切一下排列，格子永远黑"。
  const cur = canvasRefs.get(id)
  if (cur && !cur.isConnected) canvasRefs.delete(id)
}

// 排列/聚焦一换，自己的预览 <video> 会整段重挂载，srcObject 必须跟着挂回去，
// 否则会出现"在推流但主画面全黑"。
// 这块原先用的是 v-for 里的字符串 ref（ref="selfRef"）—— Vue 会把 v-for 的同名 ref
// 收进**数组**，于是 `selfRef.value.srcObject = stream` 只是给数组挂了个不相干的属性，
// 自己那一格永远是黑的（第 44 项：入会后看不到自己的画面）。改成显式登记元素。
function attachSelf(v: HTMLVideoElement) {
  if (!selfStream.value) return
  if (v.srcObject !== selfStream.value) v.srcObject = selfStream.value
  if (v.paused) void v.play().catch(() => { /* 自动播放被拦时不弹技术细节，画面稍后自起 */ })
}

function setSelfRef(el: unknown) {
  if (!el) return
  const v = el as HTMLVideoElement
  selfRef.value = v
  attachSelf(v)
}

watch(selfStream, () => {
  if (selfRef.value) attachSelf(selfRef.value)
})

function toggleDock(id: Exclude<DockId, 'none'>) {
  // 右侧排列的成员栏常驻，那颗「成员」键就是它的收起/展开开关。
  if (id === 'members' && layout.value === 'right' && !isCompact.value) {
    railOpen.value = !railOpen.value
    dock.value = 'none'
    return
  }
  dock.value = dock.value === id ? 'none' : id
  if (id === 'chat') {
    nextTick(() => {
      const el = document.querySelector('.cp-list')
      if (el) el.scrollTop = el.scrollHeight
    })
  }
}

type MoreCmd = 'captions' | 'assistant' | 'invite' | 'chat' | 'share' | 'stats' | 'local-rec' | 'cloud-rec' | 'settings' | 'end'

function onMoreCommand(cmd: string | number | object) {
  const c = String(cmd) as MoreCmd
  if (c === 'captions') void assistant.value?.toggleSpeech()
  else if (c === 'assistant') openAssistant('materials')
  else if (c === 'invite') showInvite.value = true
  else if (c === 'chat') toggleDock('chat')
  else if (c === 'share') void toggleShare()
  else if (c === 'stats') toggleDock('stats')
  else if (c === 'local-rec') void rsToggle().then(handleRecordResult)
  else if (c === 'cloud-rec') void toggleCloudRecord()
  else if (c === 'settings') showSettings.value = true
  else if (c === 'end') void endAll()
}

function onNotWired(label: string) {
  ElMessage.info(`${label}暂未接入`)
}

async function toggleFullscreen() {
  try {
    if (document.fullscreenElement) {
      await document.exitFullscreen()
      isFullscreen.value = false
    } else {
      await document.documentElement.requestFullscreen()
      isFullscreen.value = true
    }
  } catch {
    ElMessage.info('浏览器拒绝了全屏请求')
  }
}

async function loadInitial() {
  if (!meetingId) {
    stageNotice.value = '尚未加入会议，请先从首页进入'
    return
  }
  try {
    const res = await getMeetingState(meetingId)
    stageNotice.value = ''
    meetingStore.applyState(res.data!)
    ws.participants.value = res.data!.participants
    ws.invited.value = res.data!.invited || []
    ws.streams.value = res.data!.streams
    const hist = await getChatMessages({ meetingId, afterId: 0, limit: 100 })
    ws.messages.value = hist.data || []
  } catch (e: any) {
    // 只把后端给的可读 msg 摆上台面；链路级原文（Failed to fetch / Network Error）不进用户视野。
    const msg = e instanceof ApiError && e.reason === 'not_in_meeting'
      ? '会议连接已经断了，正在尝试恢复'
      : (e instanceof ApiError ? e.message : '会议状态获取失败，正在尝试恢复')
    console.warn('[meeting] 会中状态恢复失败', e?.name, e?.message, e)
    stageNotice.value = msg
    // 服务端已经没有这个会话了（后端重启、令牌过期、被闲置回收）。先尝试自愈：
    // 拿会议号重新 join 一次（后端重启后三方会议还在，重新入会即可恢复），
    // 恢复不了才清会议态，避免页面卡在"连接中断"却没有任何出路。
    let no = sessionStorage.getItem('meetingNo') || ''
    if (!no) {
      const detail = await getMeetingDetail(meetingId).catch(() => null)
      no = detail?.data?.meetingNo || ''
    }
    if (no) {
      try {
        await meetingStore.join(no)
        if (meetingStore.meetingId === meetingId) return loadInitial()
      } catch {
        /* 重入失败按下面的清理路径走 */
      }
    }
    // 自愈没成就说明这场会真不在了：清态 + 回未入会页。
    // 停在会中页只剩一句报错，用户既退不出去也进不去别的会。
    if (meetingStore.inMeeting) meetingStore.clear()
    void router.replace('/meeting-empty')
    return
  }
  if (!assistant.value || !(await assistant.value.admit())) return
  admitted.value = true
  await ws.connect(meetingId)
  await attachSelfMedia()
  // 不从 meetingStore.self 回读按钮状态：buildState 的 cameraOn/micOn/sharing 基于三方
  // 实际发布（realMedia），而 attachSelfMedia 刚把正确意图推给后端，三方发布还没就绪——
  // 回读只会拿到旧值覆盖本地正确值（"按钮和实际不符"的根因）。本地才是真源。
  await applyLaunchIntentOnce()
  startTicker()
  void probeNet()
  netTimer = window.setInterval(probeNet, 15000)
}

async function probeNet() {
  const p = await probeNetwork()
  net.value = p.ok ? { ...p, ...gradeNet(p.rttMs) } : null
}

function startTicker() {
  rateTimer = window.setInterval(sampleFocusRate, 1000)
  // 订阅失败的腿必须自己再来一次：attachRemoteStreams 只由 streams 列表变化驱动，
  // 对端稳定在播时列表不再变 —— 一次 502 之后那块瓦片就永远黑着（实测 2026-10-10 21:07）。
  // 已有播放器的路由各条腿自己的守卫跳过，这里只是把"没挂上"的重新问一遍。
  retryTimer = window.setInterval(() => void attachRemoteStreams(), 3000)
  // 码率遥测必须是**周期的**、不能挂在 watch 上：watch 只在值变化时触发，值恰好不变就漏报，
  // 而三方只认 4 秒内的新鲜样本。
  telemetryTimer = window.setInterval(() => void pushTelemetry(), 2000)
}

async function attachSelfMedia() {
  if (!admitted.value) return
  await media.loadPreferences()
  const kind = resolveLaunchKind()
  // 语音/共享默认不采摄像头（cameraOff 由入会意图写入）；用户点「开启视频」会先清掉再进来。
  const audioOnly =
    !!meetingStore.initialMedia.cameraOff && (kind === 'voice' || kind === 'share')
  const stream = await media.startPreview({ audioOnly })
  if (!stream) {
    cameraOn.value = false
    micOn.value = false
    stageNotice.value = media.error.value || '未获得摄像头/麦克风权限'
    return
  }
  selfStream.value = stream
  bindSelfVideoLiveEvents(stream)
  // 重采（切虚化/换摄像头）换的是轨道；人脸检测的输入必须跟着换。
  if (!audioOnly) faceRoi.attachStream(stream)
  // 这一次真的采到流了：把上一次采集失败留下的话撤掉（实测：入会瞬间采集失败、
  // 之后点「开启视频」成功，画面在动但舞台里还挂着「未获得摄像头/麦克风权限」）。
  stageNotice.value = ''
  // 预约时设定的入会初始媒体状态在这里真正落地。
  if (meetingStore.initialMedia.micOff) {
    micOn.value = false
    stream.getAudioTracks().forEach((t) => (t.enabled = false))
  }
  if (meetingStore.initialMedia.cameraOff || audioOnly) {
    cameraOn.value = false
    stream.getVideoTracks().forEach((t) => (t.enabled = false))
  }
  if (selfRef.value) attachSelf(selfRef.value)
  // 采集到"流对象"不等于采到了画面/声音：设备被别的程序占用时浏览器会给一条没有
  // live 轨的流。此前这里静默不发布，但 UI 仍显示摄像头已开、并把 cameraOn=true 报给
  // 平台 —— 对端于是永远等不到这路流（"拉不到其他参会者的音视频"的成因之一）。
  cameraMissing.value = !stream.getVideoTracks().some((t) => t.readyState === 'live')
  micMissing.value = !stream.getAudioTracks().some((t) => t.readyState === 'live')
  if (cameraMissing.value) cameraOn.value = false
  if (micMissing.value) micOn.value = false
  refreshSelfVideoLive()
  // 只有一台设备采到时，说清楚是哪一台、为什么，以及现在靠什么入会 ——
  // 过去这里只会甩出「摄像头/麦克风被其它程序占用」，用户去关错的东西（实测麦克风 41ms 就能出流）。
  // 语音/共享本就不采摄像头：缺视频轨不算故障，别用「摄像头被占用」吓人。
  if ((cameraMissing.value || micMissing.value) && !(audioOnly && !micMissing.value)) {
    if (audioOnly && micMissing.value) {
      stageNotice.value = `麦克风${media.captureIssue.value.mic || '没能采到'}，语音暂不可用`
    } else if (!audioOnly) {
      const failed = cameraMissing.value && micMissing.value ? '摄像头和麦克风' : cameraMissing.value ? '摄像头' : '麦克风'
      const kept = cameraMissing.value && micMissing.value ? '' : cameraMissing.value ? '声音' : '画面'
      const why = (cameraMissing.value ? media.captureIssue.value.camera : media.captureIssue.value.mic) || '没能采到'
      stageNotice.value = `${failed}${why}，本次只用${kept}入会；需要时可在下方按钮重试`
    }
  }
  startSpeaking(stream)
  await pushMediaState()
  // 本地预览只证明"我采到了"，别人能不能看到取决于这条 WHIP 发布。
  // 但会议还没开始时三方不接受发布（实测预约会议回 meeting_not_running），
  // 硬推只会换来两句一模一样的报错 —— 先把这条腿收住，等转 running 再补推。
  if (!canPublish.value) {
    pendingSelfPublish = true
    if (!stageNotice.value) stageNotice.value = '会议尚未开始，开始后自动推送本端画面与声音'
    return
  }
  // 对齐三方 changeVirtualBackground → replaceCameraPublicationTrack：
  // 已发布时只原地换轨（不拆连接、不重新协商），避免跨侧转发因 publication 重建而断流。
  const existingVideoTrack = stream.getVideoTracks().find((t) => t.readyState === 'live')
  if (whip.published() && existingVideoTrack && cameraOn.value) {
    try {
      if (whip.canReplaceVideoTrack(existingVideoTrack)) await whip.replaceVideoTrack(existingVideoTrack)
      else await publishCamera()
    } catch (e) {
      console.warn('[whip] 原地换轨失败，回退全量重发布', e)
      await publishCamera().catch(() => {})
    }
  } else {
    await publishSelfLanes()
  }
}

// 本端两条发布分开走：对齐三方（restartCameraPublication），camera 发布只装视频轨，
// 音轨走独立 audio 发布。
async function publishSelfLanes() {
  try {
    if (cameraOn.value) await publishCamera()
  } catch (e) {
    console.error('[whip] 媒体发布失败:', e)
    const msg = describePublishError(e, '画面没能推出去，请重试')
    if (msg) ElMessage.error(msg)
  }
  try {
    if (micOn.value) await publishMicrophone()
  } catch (e) {
    console.error('[whip] 麦克风发布失败:', e)
    const msg = describePublishError(e, '声音没能推出去，请重试')
    if (msg) ElMessage.error(msg)
  }
}

// 三方逆向：camera 与麦克风是两条独立 WHIP（mediaKind 分别为 camera/audio）。
// 把音轨捆进 camera 发布里，三方媒体服务器只转视频——对端必然听不见（本次修复的主因）。
async function publishCamera(): Promise<boolean> {
  const vt = selfStream.value?.getVideoTracks().find((t) => t.readyState === 'live')
  if (!vt) return false
  await whip.publish(new MediaStream([vt]), {
    mediaKind: 'camera',
    targetBitrateKbps: media.prefs.value?.videoTargetBitrateKbps ?? 0,
    delivery: deliveryFor('camera'),
    preferredFps: media.prefs.value?.videoMaxFps,
    physicalFrames: media.physicalCameraFrames,
    captureTrack: media.capturedCameraTrack,
    onVideoSample: sample => { cameraSample.value = sample },
    mediaLabel: (vt.label || '本页摄像头').slice(0, 128),
    onState: (s) => (publishState.value = s),
    onRate: (kbps, _targetKbps, fps) => { cameraUpKbps.value = kbps; cameraFps.value = fps },
    onBytes: (b) => (uplinkBytes.value = b),
  })
  // 每次发布都会新建 publicationId；人脸框必须跟着绑到新发布上。
  const pubId = whip.publicationIdOf()
  if (pubId) faceRoi.bind(meetingId, pubId)
  return true
}

/** 保证 selfStream 上有一条 live 音轨；入会时没采到麦、或轨已 ended 时现场补采。 */
async function ensureLiveMicTrack(): Promise<MediaStreamTrack | null> {
  const existing = selfStream.value?.getAudioTracks().find((t) => t.readyState === 'live')
  if (existing) return existing
  const track = await acquireMicrophoneTrack(media.effectivePrefs())
  if (!track) return null
  if (!selfStream.value) {
    selfStream.value = new MediaStream([track])
  } else {
    // 清掉已 ended 的旧音轨，避免 publish 再捡到死轨。
    selfStream.value.getAudioTracks().forEach((t) => {
      if (t.readyState !== 'live') {
        try {
          selfStream.value?.removeTrack(t)
        } catch {
          /* ignore */
        }
        t.stop()
      }
    })
    selfStream.value.addTrack(track)
  }
  micMissing.value = false
  meetingStore.initialMedia = { ...meetingStore.initialMedia, micOff: false }
  return track
}

async function publishMicrophone(): Promise<boolean> {
  const at = await ensureLiveMicTrack()
  if (!at) return false
  at.enabled = true
  await whipAudio.publish(new MediaStream([at]), {
    mediaKind: 'audio',
    targetBitrateKbps: media.prefs.value?.videoTargetBitrateKbps ?? 0,
    // 三方 audio 发布用真实麦克风 label（缺省"默认麦克风"）。
    mediaLabel: (at.label || '默认麦克风').slice(0, 128),
    onRate: (kbps) => (micUpKbps.value = kbps),
  })
  return true
}

async function pushMediaState() {
  const s = { cameraOn: cameraOn.value, micOn: micOn.value, sharing: sharing.value }
  ws.send('media', s)
  // REST 快速通道为准：WS 未连上/重连窗口里 send 是静默丢弃的，而三方按意图位过滤
  // 发布可见性——位没送达，对端连这个端的画面和声音都看不到（实测手机"没开麦"事故）。
  try {
    await reportMediaState(meetingId, s)
  } catch (e) {
    console.error('[media-state] 意图上报失败（泵心跳仍会带最新值）:', e)
  }
}

// 摄像头和共享屏幕各自上报浏览器端的采集与发送样本，供接口调试。
function telemetryItems(): TelemetryItem[] {
  const items: TelemetryItem[] = []
  const cam = whip.publicationIdOf()
  if (cam && cameraSample.value && performance.now() - cameraSample.value.at < 3500) {
    items.push({
      publicationId: cam,
      sourceVideoBitrateKbps: cameraUpKbps.value,
      sourceFps: cameraFps.value,
      captureFps: cameraSample.value.captureFps, publishFps: cameraSample.value.publishFps,
      publishKbps: cameraSample.value.publishKbps, decodedFrameKbps: cameraSample.value.decodedFrameKbps,
      associatedAudioBitrateKbps: micUpKbps.value > 0 ? micUpKbps.value : 0,
    })
  }
  const scr = whipScreen.publicationIdOf()
  if (scr && screenSample.value && performance.now() - screenSample.value.at < 3500) {
    items.push({
      publicationId: scr,
      sourceVideoBitrateKbps: screenUpKbps.value,
      sourceFps: screenFps.value,
      captureFps: screenSample.value.captureFps, publishFps: screenSample.value.publishFps,
      publishKbps: screenSample.value.publishKbps, decodedFrameKbps: screenSample.value.decodedFrameKbps,
      associatedAudioBitrateKbps: 0,
    })
  }
  return items
}

// 每两秒通过 REST 和 WebSocket 上报同一批样本，覆盖 WebSocket 重连窗口。
async function pushTelemetry() {
  const items = telemetryItems()
  if (!items.length) return
  ws.send('telemetry', { items })
  try {
    await reportTelemetry(meetingId, items)
  } catch (e) {
    console.error('[telemetry] 码率上报失败（2 秒后重来）:', e)
  }
}

async function toggleMic() {
  micOn.value = !micOn.value
  // 对齐三方 detachLocalMediaImmediately：静音=拆掉整条 audio 发布（而不是发停不掉的黑轨），
  // 解除静音=重新发布。没有 live 音轨时先补采（入会默认关麦/换机后旧 deviceId 失效都会走到这）。
  try {
    if (micOn.value) {
      const track = await ensureLiveMicTrack()
      if (!track) {
        micOn.value = false
        micMissing.value = true
        await pushMediaState()
        const insecure = typeof window !== 'undefined' && !window.isSecureContext
        ElMessage.warning(
          insecure
            ? '当前是 http 地址，浏览器可能禁止麦克风；请用 https 或本机 localhost 打开后再试'
            : (media.captureIssue.value.mic
              ? `麦克风${media.captureIssue.value.mic}，无法开麦`
              : '麦克风没有可推的音频，请检查权限或关闭占用麦克风的其它程序后重试'),
        )
        return
      }
      track.enabled = true
      selfStream.value?.getAudioTracks().forEach((t) => (t.enabled = true))
      startSpeaking(selfStream.value)
      await pushMediaState()
      if (!canPublish.value) {
        pendingSelfPublish = true
        return
      }
      const ok = await publishMicrophone()
      if (!ok) {
        micOn.value = false
        micMissing.value = true
        await pushMediaState()
        ElMessage.warning('麦克风没有可推的音频，请检查权限或关闭占用麦克风的其它程序后重试')
      }
    } else {
      selfStream.value?.getAudioTracks().forEach((t) => (t.enabled = false))
      await pushMediaState()
      await whipAudio.unpublish()
    }
  } catch (e) {
    console.error('[whip] 麦克风发布切换失败:', e)
    const msg = describePublishError(e, '麦克风这次没切换成功，请重试')
    if (msg) ElMessage.error(msg)
  }
  // 录制的这一路跟着意图位立刻定终点：关麦=这一路到此为止（留缺口），开麦=新的一条路。
}

async function toggleCamera() {
  const turningOn = !cameraOn.value
  // 语音/共享入会时只采了麦：首次开视频要重采，否则没有可推的画面轨。
  if (turningOn && !selfStream.value?.getVideoTracks().some((t) => t.readyState !== 'ended')) {
    cameraOn.value = true
    // 必须先清 cameraOff，否则 attachSelfMedia 仍会按入口只采麦。
    meetingStore.initialMedia = { ...meetingStore.initialMedia, cameraOff: false }
    if (resolveLaunchKind() === 'voice') {
      // 语音场开了摄像头后仍保留语音舞台；只放开采集约束。
      sessionStorage.setItem('conference.voiceAllowCamera', '1')
    }
    await attachSelfMedia()
    return
  }
  cameraOn.value = turningOn
  selfStream.value?.getVideoTracks().forEach((t) => (t.enabled = cameraOn.value))
  refreshSelfVideoLive()
  await pushMediaState()
  // 同麦克风：关视频=拆 camera 发布，对端立刻收不到流而不是收到黑帧。
  try {
    if (cameraOn.value) {
      if (!canPublish.value) {
        pendingSelfPublish = true
        return
      }
      const ok = await publishCamera()
      if (!ok) {
        cameraOn.value = false
        cameraMissing.value = true
        refreshSelfVideoLive()
        await pushMediaState()
        ElMessage.warning('摄像头没有可推的画面，可能被其他程序占用')
      }
    } else {
      faceRoi.unbind()
      await whip.unpublish()
    }
  } catch (e) {
    console.error('[whip] 摄像头发布切换失败:', e)
    const msg = describePublishError(e, '摄像头这次没切换成功，请重试')
    if (msg) ElMessage.error(msg)
  }
}

async function toggleShare() {
  if (!admitted.value) return
  if (sharing.value) {
    await whipScreen.unpublish().catch(() => undefined)
    shareStream.value?.getTracks().forEach((t) => t.stop())
    shareStream.value = null
    sharing.value = false
    await pushMediaState()
    return
  }
  if (!navigator.mediaDevices?.getDisplayMedia) {
    ElMessage.error('当前浏览器不支持屏幕共享')
    return
  }
  // 三方平台规定同一时刻只允许一位参会者共享屏幕（ocean-meeting.js 同款前置检查），
  // 先查真实发布流而不是意图位，撞车时别人才会收到 screen_share_in_use 拒绝。
  const blocker = streams.value.find((s) => s.kind === 'screen' && s.active && s.ownerId !== myId.value)
  if (blocker) {
    ElMessage.warning(`当前已有参会者共享屏幕（${blocker.ownerName}），请等待其停止共享`)
    return
  }
  try {
    // 带 max 约束采集，避免整屏 DPI 缩放后的非标分辨率（实测 2561x1601@30）被三方拒
    // bad_publication_video_spec；对齐三方 startScreenShare 的 requestedSpec 约束。
    const s = await navigator.mediaDevices.getDisplayMedia({
      video: { width: { ideal: 1920, max: 1920 }, height: { ideal: 1080, max: 1080 }, frameRate: { ideal: media.prefs.value?.videoMaxFps || 30, max: media.prefs.value?.videoMaxFps || 30 } },
      audio: true,
    })
    shareStream.value = s
    sharing.value = true
    // contentHint 是浏览器编码器真正消费的输入：画质优先→detail，其余→motion。
    const vt = s.getVideoTracks()[0]
    if (vt) vt.contentHint = deliveryFor('screen').encodingStrategy === 'bandwidth_first' ? 'detail' : 'motion'
    vt?.addEventListener('ended', async () => {
      await whipScreen.unpublish().catch(() => undefined)
      shareStream.value = null
      sharing.value = false
      await pushMediaState()
    })
    await pushMediaState()
    // 采到共享轨就先开这一路的录制：别人看不看得到是发布的事，本机这份是原始轨。
    // 采集到 ≠ 别人能看到：必须把这条共享流发布出去（对齐三方 startScreenShare：
    // 岸端直接透传采集轨 + mediaKind=screen 独立发布，不做帧处理）。
    try {
      await whipScreen.publish(s, {
        mediaKind: 'screen',
        targetBitrateKbps: media.prefs.value?.videoTargetBitrateKbps ?? 0,
        delivery: deliveryFor('screen'),
        preferredFps: media.prefs.value?.videoMaxFps,
        onVideoSample: sample => { screenSample.value = sample },
        // 三方用真实轨道 label 当 mediaLabel（如"屏幕：某个窗口"），截 128。
        mediaLabel: (s.getVideoTracks()[0]?.label || '屏幕共享').slice(0, 128),
        onState: (st) => (screenPublishState.value = st),
        onRate: (kbps, _targetKbps, fps) => { screenUpKbps.value = kbps; screenFps.value = fps },
      })
    } catch (e) {
      // 发布失败就把共享整体回滚（对齐三方 catch 路径）：留着采集轨只会谎报"我在共享"。
      console.error('[whip] 屏幕共享发布失败:', e)
      shareStream.value?.getTracks().forEach((t) => t.stop())
      shareStream.value = null
      sharing.value = false
      await pushMediaState()
      ElMessage.error('屏幕共享没推出去，已停止，请重试')
    }
  } catch {
    ElMessage.info('已取消屏幕共享')
  }
}

function toggleCloudRecord() { void assistant.value?.toggleRecording() }

// —— 本地录制（第 15/17 项）——————————————————————————————————————————
// 以前是一条混合流：把舞台画到一张画布上录，谁后来入会、谁关了摄像头都不在文件里，
// 而且整场只在点停止时拼一个 Blob —— 页面崩了就什么都不剩。
// 现在每路媒体（每个参会者的摄像头/屏幕/麦克风 + 本端自己）各自一个 MediaRecorder，
// 每 2 秒出一个片**立刻入库**；时间轴只有一个 t0 = 会话开始的 epoch 毫秒，所有片按它排位。
// 某一路停推就关掉那一路、留下缺口；同一个人再入会是**新的一条路**，offset 仍按同一个 t0 排。
// 悬停说清"此刻正在分别保存哪几路"——路数来自录制会话自己的快照，不是参会人数。
const localRecordTitle = computed(() =>
  isLocalRecording.value
    ? `正在分别保存本端与在会每一路的画面与声音（当前 ${recTrackCount.value} 路）；随时可停，已录的部分不会丢`
    : '本地录制：每路画面与声音各存一条，结束后写进所选目录',
)

function handleRecordResult(result: string) {
  if (result === 'no_tracks') ElMessage.warning('没有可录制的画面或声音')
  else if (result === 'not_supported') ElMessage.warning('此浏览器不支持录制')
  else if (result === 'open_failed') ElMessage.error('录制启动失败')
  // 同一键上已经挂着一条在录的路：这条不许静默并写（那份清单会缺一路却被当成完整的）
  else if (result === 'lane_busy') ElMessage.error('本地录制没能开始：有一路已在录制中，请先停止后重试')
  else if (result === 'no_space') ElMessage.error('这台电脑的存储空间不够，先删掉几场旧录制再开本地录制')
}

function recordingUserName(): string {
  return userStore.userInfo?.displayName || meetingStore.self?.name || myName.value || ''
}

/** 此刻该在录的路。判据全部是真实轨道/真实渲染状态，不是"清单里应该有几路"。 */
function desiredTracks(): DesiredTrack[] {
  const out: DesiredTrack[] = []
  const selfId = myId.value || 'self'
  const selfName = myName.value || '本机'
  const cam = cameraOn.value ? selfStream.value?.getVideoTracks().find((t) => t.readyState === 'live') : null
  if (cam) {
    out.push({
      key: 'self-camera',
      src: { ownerId: selfId, ownerName: selfName, kind: 'camera', mediaLabel: cam.label || '本页摄像头', video: { track: cam } },
    })
  }
  const mic = micOn.value ? selfStream.value?.getAudioTracks().find((t) => t.readyState === 'live') : null
  if (mic) {
    out.push({
      key: 'self-microphone',
      src: { ownerId: selfId, ownerName: selfName, kind: 'microphone', mediaLabel: mic.label || '默认麦克风', audioTracks: [mic] },
    })
  }
  const screen = sharing.value ? shareStream.value?.getVideoTracks().find((t) => t.readyState === 'live') : null
  if (screen) {
    out.push({
      key: 'self-screen',
      src: {
        ownerId: selfId,
        ownerName: selfName,
        kind: 'screen',
        mediaLabel: screen.label || '屏幕共享',
        video: { track: screen },
        audioTracks: shareStream.value?.getAudioTracks() || [],
      },
    })
  }
  for (const s of subscribableStreams.value) {
    const lane: DesiredTrack['src'] = {
      ownerId: s.ownerId,
      ownerName: s.ownerName,
      kind: s.kind === 'screen' ? 'screen' : 'camera',
      mediaLabel: s.kind === 'screen' ? '共享屏幕' : '摄像头',
    }
    // 只按 videoChannel 判"这一路真有在产画面的源"：缺键 = 本实例接不通，那块画布没人画，
    // 登进去只能录出一路纯黑。键带上源形态，换腿时对账就是关旧开新，不会让一条录不到像素的路挂着。
    const whepTrack = isWhepVideoChannel(s.videoChannel) && lanWhepFramed.has(s.id)
      ? lanWhepVideo.value[s.id]?.getVideoTracks().find((t) => t.readyState === 'live') ?? null
      : null
    if (s.video && whepTrack) {
      out.push({ key: `remote-${s.id}-video-track`, src: { ...lane, video: { track: whepTrack } } })
    } else if (s.video && s.videoChannel === 'direct' && videoPlayers.has(s.id)) {
      const canvas = canvasRefs.get(s.id)
      if (canvas?.isConnected) {
        out.push({
          key: `remote-${s.id}-video-canvas`,
          src: { ...lane, video: { canvas: () => canvasRefs.get(s.id) || null, fps: s.fps || 15 } },
        })
      }
    }
    const audioStream = getRemoteAudioStream(s.id)
    if (s.audio && audioStream?.getAudioTracks().length) {
      out.push({
        key: `remote-${s.id}-audio`,
        src: {
          ownerId: s.ownerId,
          ownerName: s.ownerName,
          kind: 'microphone',
          mediaLabel: s.kind === 'audio' ? '麦克风' : '随路声音',
          audioTracks: audioStream.getAudioTracks(),
        },
      })
    }
  }
  return out
}

// 云端会饿着"没人关注"的流：实测不 focus 时下行只有 ~70kbps 且首字节 700ms+，
// focus 后涨到 ~176kbps、首字节 1ms。所以开始渲染就必须上报关注，不能等用户点击。
// 与 focus() 的区别：这里不改高亮框（focusedId 表示的是用户主动选中的那一路）。
function requestAttention(id: string) {
  // silent：这是渲染侧的自动上报，失败对用户不可操作。不静音的话，会议一结束
  // 还在途的那次 focus 会弹「本端会议会话已失效，请重新入会」打扰收尾（第 42 项）。
  focusStream(meetingId, id, true).catch(() => {
    /* 通知失败不打断观看 */
  })
}

async function focus(id: string) {
  focusedId.value = id
  try {
    await focusStream(meetingId, id, true)
  } catch {
    /* 通知失败不打断观看 */
  }
}
function focusSelf() {
  focusedId.value = SELF_FOCUS
}

async function sendChat() {
  const text = chatDraft.value.trim()
  if (!text) return
  chatDraft.value = ''
  try {
    await ws.sendChat(text)
  } catch (e) {
    chatDraft.value = text
    console.warn('[meeting] 发送聊天消息失败', e)
    ElMessage.error('消息没有发出去，请检查网络后重试')
  }
}

function deliveryFor(kind: VideoKind) {
  return readDelivery(userStore.userInfo?.username || '', kind)
}
async function applyVideoDelivery(kind: VideoKind, value: VideoDelivery): Promise<boolean> {
  const id = await (kind === 'camera' ? whip : whipScreen).publicationIdWhenReady()
  if (!id) return false
  await setVideoDelivery(meetingId, id, value)
  return true
}
function resolveLaunchKind(): string {
  const k = (meetingStore.launchKind || sessionStorage.getItem('conference.launchKind') || '').trim().toLowerCase()
  if (k === 'share' || k === 'voice' || k === 'scheduled' || k === 'quick') return k
  return 'quick'
}

const isVoiceMode = computed(() => resolveLaunchKind() === 'voice')
const isShareMode = computed(() => resolveLaunchKind() === 'share')

const voiceRemotePeers = computed(() => joinedRows.value.filter((r) => !r.isSelf))
/** 语音舞台：对方优先居中展示，自己放次位；无人时只显示自己。 */
const voiceStagePeers = computed(() => {
  const remotes = voiceRemotePeers.value
  const self = joinedRows.value.find((r) => r.isSelf)
  if (remotes.length) return [...remotes, ...(self ? [self] : [])]
  return self ? [self] : []
})

const kindBadge = computed(() => {
  switch (resolveLaunchKind()) {
    case 'share':
      return '共享屏幕'
    case 'voice':
      return '语音对讲'
    case 'scheduled':
      return '预约会议'
    default:
      return ''
  }
})

async function applyLaunchIntentOnce() {
  if (launchIntentApplied) return
  launchIntentApplied = true
  const kind = resolveLaunchKind()
  if (kind === 'share') {
    cameraOn.value = false
    meetingStore.initialMedia = { ...meetingStore.initialMedia, cameraOff: true }
    if (!sharing.value) {
      // 共享入口：立刻选屏推给对方，不打开摄像头。
      await toggleShare()
    }
  }
}

async function onPrefsChanged() {
  await attachSelfMedia()
  await media.setElementSink([...streamRefs.values()], media.effectivePrefs()?.speakerDeviceId || '')
}

async function leave() {
  stopTicker()
  void rsStop()
  try {
    await meetingStore.leave()
  } catch (e) {
    console.warn('[meeting] 离开会议失败', e)
    ElMessage.error('离开会议没有成功，请重试或刷新页面')
  }
  router.push('/meeting-empty')
}

async function endAll() {
  try {
    await ElMessageBox.confirm('结束会议将把所有参会者移出，确定继续？', '结束会议', { type: 'warning' })
  } catch {
    return
  }
  stopTicker()
  void rsStop()
  try {
    await endMeeting(meetingId)
    meetingStore.clear()
    ElMessage.success('会议已结束')
    router.push('/meeting-empty')
  } catch (e) {
    console.warn('[meeting] 结束会议失败', e)
    ElMessage.error('结束会议没有成功，请稍后重试')
  }
}

function stopTicker() {
  if (rateTimer !== null) clearInterval(rateTimer)
  rateTimer = null
  if (statBarTimer !== null) window.clearTimeout(statBarTimer)
  statBarTimer = null
  if (netTimer !== null) clearInterval(netTimer)
  netTimer = null
  if (retryTimer !== null) clearInterval(retryTimer)
  retryTimer = null
  if (telemetryTimer !== null) clearInterval(telemetryTimer)
  telemetryTimer = null
  stopSpeaking()
  void whip.unpublish()
  void whipAudio.unpublish()
  void whipScreen.unpublish()
  faceRoi.stop()
  // 必须走 stopPreview：虚化的帧循环与 segmenter 只在它里面 dispose。
  // 直接停轨道会让处理会话活到页面卸载。
  media.stopPreview(selfStream.value)
  selfStream.value = null
  selfLiveCleanup?.()
  selfLiveCleanup = null
  selfVideoLive.value = false
  shareStream.value?.getTracks().forEach((t) => t.stop())
  streamRefs.forEach((el) => {
    el.pause()
    el.srcObject = null
  })
  videoPlayers.forEach((p) => p.stop())
  videoPlayers.clear()
  playerCanvases.clear()
  stopMirrorLoop()
  mirrorRefs.clear()
  audioPlayers.forEach((p) => p.stop())
  audioPlayers.clear()
  for (const id of [...whepVideoPlayers.keys()]) dropLanWhepLeg(id)
}

// 订阅远端流：视频是逐帧媒体流，要自己解帧 + WebCodecs 解码再上 canvas（`<video src>` 播不了这种裸流），
// 远端流交给后端提供的播放器：容器解析、avcC/参数集、
// AVCC 长度前缀、渲染节奏、以及 onRate/onTraffic 都由它负责。
// 自己重写这套已被证明是重复劳动，而且会在 avcC 细节上反复踩坑。
let mediaEngine: MediaPlayer | null = null

function clearStreamError(id: string) {
  const next = { ...streamError.value }
  delete next[id]
  streamError.value = next
  // 播上了就得把"准备中"的历史清掉，否则这路下次真开始预热时会立刻被算成超时。
  warmingSince.delete(id)
}

// WS 每秒推一次 streams，失败后若无节制就会每秒重建一次播放器（实测刷出上百次重试，
// 等于自己打自己后端）。失败后给这路流一段冷却，到点再试。
const retryBlockedUntil = new Map<string, number>()
function retryBlocked(id: string): boolean {
  const until = retryBlockedUntil.get(id) || 0
  if (Date.now() < until) return true
  retryBlockedUntil.delete(id)
  return false
}
function blockRetry(id: string, ms = 10000) {
  retryBlockedUntil.set(id, Date.now() + ms)
}
// 「订不上这一路」该怎么动：只读机器输入 —— 信封 `reason`、HTTP 状态、本轮 state 的事实。
// 视频腿走托管播放器（前两者都不回吐），所以那条腿改读 state —— 不许比对后端中文文案（契约 §1、ADR-0052）。
const MEETING_OVER_STATES = ['ended', 'cancelled', 'failed']
function streamFailureKind(s: StreamVo, e: unknown, playable: boolean): StreamFailure {
  const se = e as { reason?: unknown; status?: unknown }
  return classifyStreamFailure({
    reason: typeof se?.reason === 'string' ? se.reason : '',
    status: typeof se?.status === 'number' ? se.status : undefined,
    inLatestState: streams.value.some((x) => x.id === s.id),
    meetingOver: MEETING_OVER_STATES.includes(meetingStore.state?.status || ''),
    playable,
  })
}

// 中间态那句提示：音频腿拿得到后端 msg 就照实回（第 7 项）；视频腿的原文是托管播放器吐的，不许上桌。
function warmingText(e: unknown): string {
  return e instanceof SubscribeError ? e.message : '这路画面还在准备中'
}

// 「还在准备中」不许无限挂着：实测一条永远不会就绪的流在这里每 1.5 秒取一次、连挂四十五分钟
// （后端 195 次 425），用户面对的就是一块永远不亮的瓦片。试过这个时长就换成如实的"一直没准备好"，
// 并退回常规冷却 —— 仍在试，但不再高频自打后端。
const WARMING_LIMIT_MS = 30000
const warmingSince = new Map<string, number>()
function warmingOutcome(id: string, e: unknown, exceededText: string): string {
  const since = warmingSince.get(id)
  if (since === undefined) warmingSince.set(id, Date.now())
  const exceeded = since !== undefined && Date.now() - since > WARMING_LIMIT_MS
  blockRetry(id, exceeded ? 10000 : 1500)
  return exceeded ? exceededText : warmingText(e)
}

// 我方自己拆掉的播放器会 abort 在途响应体，`start()` 于是回失败 —— 那不是链路故障，
// 不能挂红字也不能进冷却（实测 2026-09-28 右侧排列：切一次排列就对着黑格等十秒）。
// 判据用"注册表里还是不是这个实例"：每个 stop 点都同时摘条目，所以不在册 = 我们自己关的（或被新的顶替了）。
// 原先是比错误文本里有没有 "aborted"：那是引擎措辞，换版本就失灵；更要命的是**真故障的原文里带这个词时，
// 会被当成"自己关的"静默吞掉** —— 该报错的不报，比多弹一条提示严重得多（第 7 项：按机器值判分支，不靠文案）。

async function attachRemoteStreams() {
  // WS 每秒推一次 streams，上一轮还在 await 里时重入，会给同一路流建出两个播放器 ——
  // 那是自己打自己后端，表现为偶发"起播失败"。
  if (attachingStreams) return
  attachingStreams = true
  try {
    await attachStreamsOnce()
  } finally {
    attachingStreams = false
  }
}
let attachingStreams = false

const deliveryRevisions = new Map<string, number>()

async function attachStreamsOnce() {
  if (!mediaEngine) {
    try {
      mediaEngine = await loadMediaPlayer()
    } catch (e) {
      const msg = (e as Error).message
      for (const s of subscribableStreams.value) {
        streamError.value = { ...streamError.value, [s.id]: msg }
      }
      return
    }
  }
  // 回收已消失的流（对端停推/发布进了终态）：播放器不摘掉就会一直抱着死会话重试。
  const alive = new Set(subscribableStreams.value.map((s) => s.id))
  for (const id of deliveryRevisions.keys()) if (!alive.has(id)) deliveryRevisions.delete(id)
  for (const s of subscribableStreams.value) {
    if (!s.revision) continue
    const previous = deliveryRevisions.get(s.id)
    deliveryRevisions.set(s.id, s.revision)
    const changed = previous !== undefined && previous !== s.revision
    const video = whepVideoPlayers.get(s.id)
    const audio = audioPlayers.get(s.id)
    if (!changed && !(video && (!s.active || video.failed())) && !(audio && (!s.active || audio.failed?.()))) continue
    dropLanWhepLeg(s.id)
    audioPlayers.get(s.id)?.stop()
    audioPlayers.delete(s.id)
    delete audioDown.value[s.id]
    retryBlockedUntil.delete(s.id)
    clearStreamError(s.id)
  }
  for (const [id, p] of videoPlayers) {
    if (!alive.has(id)) { p.stop(); videoPlayers.delete(id); playerCanvases.delete(id) }
  }
  for (const [id, p] of audioPlayers) {
    if (!alive.has(id)) { p.stop(); audioPlayers.delete(id) }
  }
  // 局域网 WHEP 那一路的流与播放器一起摘：MediaStream 留在 map 里，模板会继续绑着一块死格子。
  for (const id of [...whepVideoPlayers.keys()]) {
    if (!alive.has(id)) dropLanWhepLeg(id)
  }
  // 消失的流连带摘掉它的原始音频流登记：留着会让录制对账以为这一路还能录。
  cleanupDeadAudioStreams(alive)
  // 瓦片是随这一轮 streams 才渲染出来的，canvas 要等 DOM 更新后才拿得到；
  // 不等就会看到"流在、瓦片在，但没人订阅"。
  await nextTick()
  const engine = mediaEngine
  for (const s of subscribableStreams.value) {
    // 视频和音频是同一路发布的两条腿，不是二选一：camera 发布同时带视频与音频端点时
    // 只起视频，对端就成了"看得见但听不见"。
    if (s.transportMode && !s.active) continue
    if (s.video) await attachVideoLeg(s, engine)
    if (s.audio) await attachAudioLeg(s, engine)
  }
}

async function attachVideoLeg(s: StreamVo, engine: MediaPlayer) {
  // 后端按 deployment.side 与上游给的通道定这条腿走哪条通路：只给了船端局域网 WHEP 时，
  // 画布那条通路（GET 直连拉流）注定 503，硬走它就是用户报的"这路画面一直没准备好"。
  if (isWhepVideoChannel(s.videoChannel)) return attachLanWhepVideoLeg(s)
  if (!s.videoChannel) {
    // 上游说这路有视频，但本实例一条腿都接不通（云端实例收到只给船内网的发布，
    // 或船端网关没给这条远端发布授接收槽）—— 说一句实话，别留一块黑格子让人猜。
    streamError.value = { ...streamError.value, [s.id]: '这一路画面这边收不到' }
    return
  }
  // 换腿（上游这次给了直连地址）：另一条腿必须停掉 —— 同一路订两条通路等于自己打自己的下行。
  if (whepVideoPlayers.has(s.id)) dropLanWhepLeg(s.id)
  const canvas = canvasRefs.get(s.id)
  const live = videoPlayers.get(s.id)
  if (live) {
    // 换排列、主画面与成员栏搬位，都会让这一路的 <canvas> 换成另一个 DOM 节点；
    // 播放器只认构造时那块画布，不重建就会一直往已经离开文档的画布上画 ——
    // 表现是"流在收、帧在解、速率在跳，但这一格永远黑"（实测 2026-09-28 顶部排列）。
    if (playerCanvases.get(s.id) === canvas && canvas?.isConnected) return
    live.stop()
    videoPlayers.delete(s.id)
    playerCanvases.delete(s.id)
  }
  if (!canvas || retryBlocked(s.id)) return
  const url = mediaUrl(s.endpoints.video)
  if (!url) {
    streamError.value = { ...streamError.value, [s.id]: '无可播地址' }
    return
  }
  // 必须先探测再传 codec：不传的话播放器自己探例会回 video_webcodecs_unsupported。
  // 探哪一种看后端给的 videoCodec：经边端 RKMPP 处理的那一路是 HEVC，浏览器直发是 H.264。
  // 探错腿就是"这路画面还在准备中"挂到散会 —— 后端取流用同一条判据，两边不许各猜一次。
  const probe = s.videoCodec === 'hevc' ? engine.detectHevcCodec : engine.detectH264Codec
  const probed = await probe.call(engine, s.width || undefined, s.height || undefined).catch(() => '')
  if (!probed) {
    blockRetry(s.id)
    // 第 38 项：编解码名只进日志，页面上只留用户能懂的一句。
    console.warn('[video] 本机解不了这一路的编码规格', { id: s.id, codec: s.videoCodec, w: s.width, h: s.height })
    streamError.value = { ...streamError.value, [s.id]: '这一路画面本机放不了' }
    return
  }
  console.info('[video] 取流编码', { id: s.id, lane: s.videoCodec, probed })
  const player = new engine.DirectVideoPlayer({
    canvas,
    codec: probed,
    headers: authHeaders(),
    onRate: (kbps) => videoDown.value[s.id] = kbps,
    onTraffic: (bytes) => setStreamBytes(s.id, bytes),
    onFrame: (f) => recordVideoFrame(s.id, f),
    onFirstFrame: () => clearStreamError(s.id),
    // 解码失败只从 onState 回吐（`decode_error:<原文>`），不接这条就会留下
    // "字节在灌、解码帧数 0、页面上一个字都没有"的死黑格（实测 2026-10-09 边端那一路 6.38Mbps 进、0 帧出）。
    onState: (st) => {
      const detail = String(st || '')
      console.info('[video] 播放器状态', s.id, detail)
      if (!detail.startsWith('decode_error:')) return
      console.error('[video] 解码器报错', s.id, detail.slice('decode_error:'.length))
      streamError.value = { ...streamError.value, [s.id]: '这一路画面解不出来，正在重试' }
    },
    onError: (e) => {
      // 托管播放器回吐的是厂商原文（编解码器串、内部状态词），不能贴进瓦片（第 7 项）。
      console.error('[whep] 该路解码失败', s.id, e)
      streamError.value = { ...streamError.value, [s.id]: '这一路画面解不出来，正在重试' }
    },
  })
  videoPlayers.set(s.id, player)
  playerCanvases.set(s.id, canvas)
  requestAttention(s.id)
  player.start(url).catch((e) => {
    // 不在册 = 已经被我们自己摘掉/被新实例顶替，那次 reject 不算起播失败。
    if (videoPlayers.get(s.id) !== player) return
    videoPlayers.delete(s.id)
    playerCanvases.delete(s.id)
    // 发布已进终态（对端停推/旧别名过期）：挂错误只会留一块死瓦片，
    // 下一轮 state 会把它摘掉；"还在准备中"用短间隔重试；其余错误才进 10 秒冷却。
    const kind = streamFailureKind(s, e, !!url)
    if (kind === 'terminal') clearStreamError(s.id)
    else if (kind === 'warming') { streamError.value = { ...streamError.value, [s.id]: warmingOutcome(s.id, e, '这路画面一直没准备好') } }
    else {
      // 媒体层的原始报错只进控制台：用户看不懂也不需要看懂，名牌上只说"这路画面连不上"。
      console.error('[video] 起播失败', e)
      blockRetry(s.id)
      streamError.value = { ...streamError.value, [s.id]: '这路画面连不上，正在重试' }
    }
  })
}

// 摘腿时"出过帧"这条证据必须跟着走：换腿后拿旧证据登记新腿，录的就是根本没在收的那一路。
function dropLanWhepLeg(id: string) {
  const player = whepVideoPlayers.get(id)
  if (!player) return
  player.stop()
  whepVideoPlayers.delete(id)
  delete videoDown.value[id]
  lanWhepFrameWatch.get(id)?.()
  lanWhepFrameWatch.delete(id)
  lanWhepTimeWatch.get(id)?.()
  lanWhepTimeWatch.delete(id)
  lanWhepFramed.delete(id)
  // 基准与统计条目必须跟着腿一起走：留着就是拿上一腿的起点量这一腿，
  // 界面上会显示一个既不属于旧腿也不属于新腿的延迟数。
  driftMeters.delete(id)
  if (streamStats.value[id]) {
    const restStats = { ...streamStats.value }
    delete restStats[id]
    streamStats.value = restStats
  }
  const rest = { ...lanWhepVideo.value }
  delete rest[id]
  lanWhepVideo.value = rest
}

// 协商已成的腿只差帧，正常起播是秒级的事；等满 15 秒（≈下行速率十余次采样）还一帧不出，
// "还在准备中"就站不住了。这段没出帧的时间本来就不录，等得起。
const LAN_WHEP_FIRST_FRAME_MS = 15000

// 船端形态下云端参会者的视频只有 RK 局域网 WHEP 这一条腿（网关一条直连地址都不给）。
// 协商经我方后端代理，画面绑到那一格的 <video> 上 —— 不探编码、不走画布。
async function attachLanWhepVideoLeg(s: StreamVo) {
  if (whepVideoPlayers.has(s.id) || retryBlocked(s.id)) return
  // 换腿的另一个方向：直连那条腿（画布播放器）不停掉，就会有两块画布抢同一格、两路解码器抢同一份带宽。
  const staleDirect = videoPlayers.get(s.id)
  if (staleDirect) {
    staleDirect.stop()
    videoPlayers.delete(s.id)
    playerCanvases.delete(s.id)
    // 直连腿的基准与统计同样不能留给新腿：两条腿的源时刻不在同一个起点上。
    driftMeters.delete(s.id)
    const restStats = { ...streamStats.value }
    delete restStats[s.id]
    streamStats.value = restStats
  }
  const player = await subscribeWhepVideo(
    whepSubscribePath(meetingId, s.id),
    (kbps) => videoDown.value[s.id] = kbps,
    (st) => recordLanWhepStats(s.id, st),
  ).catch((e) => {
    const kind = streamFailureKind(s, e, true)
    if (kind === 'terminal') { clearStreamError(s.id); return null }
    if (kind === 'warming') { streamError.value = { ...streamError.value, [s.id]: warmingOutcome(s.id, e, '这路画面一直没准备好') }; return null }
    blockRetry(s.id)
    console.warn('[video] 局域网通道订阅失败', s.id, e)
    // 后端那句 msg 已按成因写好（含"请退出后重新进入会议"这类可动作的），前端不改写。
    const msg = e instanceof SubscribeError && e.message ? e.message : '这路画面连不上，正在重试'
    streamError.value = { ...streamError.value, [s.id]: msg }
    return null
  })
  if (!player) return
  whepVideoPlayers.set(s.id, player)
  lanWhepVideo.value = { ...lanWhepVideo.value, [s.id]: player.stream }
  // 与直连腿同一件事：上游按"没人关注"饿着流，订阅成功也要把关注报上去。
  requestAttention(s.id)
  // 协商成了不等于有画面：先按预热那句挂着，真出过一帧才清错误、才登记这一路。
  streamError.value = { ...streamError.value, [s.id]: '这路画面还在准备中' }
  lanWhepFrameWatch.set(
    s.id,
    observeVideoFirstFrame(player.element, () => {
      if (whepVideoPlayers.get(s.id) !== player) return
      lanWhepFramed.add(s.id)
      clearStreamError(s.id)
      // 出过帧才挂帧时刻监视：这一路的源时刻只能从"哪一帧被画出来了"问出来，
      // 没出帧时挂上是空转，还会把上一腿的基准带过来。
      lanWhepTimeWatch.set(s.id, observeFrameTimes(player.element, (t) => {
        recordDrift(s.id, { sourceMs: t.sourceMs, observedMs: t.observedMs })
      }))
    }),
  )
  window.setTimeout(() => {
    if (whepVideoPlayers.get(s.id) !== player || lanWhepFramed.has(s.id)) return
    streamError.value = { ...streamError.value, [s.id]: '这路画面一直没准备好' }
    // 只进日志，且必须拼成**一行字符串**：控制台序列化会把对象参数丢掉，只留第一个标量
    // （这次就是靠扁平文本才看清"字节在进、一帧没出"断在哪一环）。
    // 分得清两种病：framesDecoded=0 是上游没给可解的帧；dec>0 而 videoWidth=0 是元素没播起来。
    const el = player.element as HTMLVideoElement
    void player.inbound().then((st) => console.warn('[video] 局域网通道等满没出一帧 ' + s.id
      + ' 收帧=' + st.framesReceived + ' 解帧=' + st.framesDecoded + ' 解码器=' + (st.decoder || '?')
      + ' 元素宽=' + (el.videoWidth || 0) + ' readyState=' + el.readyState + ' paused=' + el.paused))
  }, LAN_WHEP_FIRST_FRAME_MS)
}

async function attachAudioLeg(s: StreamVo, engine: MediaPlayer) {
  if (audioPlayers.has(s.id) || retryBlocked(s.id)) return
  // 音频有两条通路，两条都要试到：先 WHEP，订不上就换直连播放器（下面那段）。
  // 只有 501（我方自己回"这路没有该通道"）算正常分支 —— 不进冷却，也不算失败。
  const whep = await subscribeWhepAudio(
    whepSubscribePath(meetingId, s.id),
    (kbps) => audioDown.value[s.id] = kbps,
    (st) => recordLanWhepStats(s.id, st),
  ).catch((e) => {
    if (e instanceof SubscribeError && e.status === 501) return null
    const kind = streamFailureKind(s, e, !!mediaUrl(s.endpoints.audio))
    if (kind === 'terminal') { clearStreamError(s.id); return null }
    if (kind === 'warming') { streamError.value = { ...streamError.value, [s.id]: warmingOutcome(s.id, e, '这路声音一直没准备好') }; return null }
    blockRetry(s.id)
    console.warn('[audio] 订阅失败', e)
    // 还有直连那条腿可用时不弹错：紧接着就会去开直连播放器，声音照样能听到 ——
    // 弹一句"音频订阅失败"等于把一次已经兜住的失败报给用户（第 7 项：错误要说用户能行动的话）。
    if (!mediaUrl(s.endpoints.audio)) {
      streamError.value = { ...streamError.value, [s.id]: '音频订阅失败，正在重试' }
    }
    return null
  })
  if (whep) {
    audioPlayers.set(s.id, whep)
    audioLegKind.value = { ...audioLegKind.value, [s.id]: 'whep' }
    // 录制要的是这一路的**原始音频流**：WHEP 的接收流就是它，元素挂 body 只是播出用的外壳。
    const src = whep.element.srcObject
    if (src instanceof MediaStream) setRemoteAudioStream(s.id, src)
    // 音频这路也要声明关注：上游按"没人关注"饿着流，实测不 focus 时几乎收不到下行。
    requestAttention(s.id)
    clearStreamError(s.id)
    return
  }
  // WHEP 订不上不等于这路声音收不到：岸端形态下还有直连压缩流这一条通道。原先只有 501
  // （我方自己回"这路没有该通道"）才回落，于是 401/404 这类"此刻不被认"直接把这条腿放弃掉，
  // 表现是声音间歇性消失。现在两条各试各的，两条都不通才留下最后一句原因。
  const url = mediaUrl(s.endpoints.audio)
  if (!url) return
  const player = new engine.DirectAudioPlayer({
    headers: authHeaders(),
    onRate: (kbps) => audioDown.value[s.id] = kbps,
    onTraffic: (bytes) => setStreamBytes(s.id, bytes),
    // 这一路的原始音频流：播放器回吐得了，录制才有独立音轨可录；回吐不了就不录这一路声音，
    // 绝不拿别的元素凑成"这一路有声音"。
    onStream: (stream) => setRemoteAudioStream(s.id, stream),
  })
  audioPlayers.set(s.id, player)
  // 声音落到直连流这条腿：没有 PC，就没有"播放时刻"可比 —— 音画差从此是结构上取不到。
  audioLegKind.value = { ...audioLegKind.value, [s.id]: 'direct' }
  requestAttention(s.id)
  player.start(url).then(() => {
    // 换通路换成功了，把 WHEP 那句"还在准备中"撤掉：它已经不是当前事实。
    if (audioPlayers.get(s.id) === player) clearStreamError(s.id)
  }).catch((e) => {
    // 同上：不在册说明这一路已经被我们自己摘掉或被新实例顶替，那次 reject 不算这路的失败。
    if (audioPlayers.get(s.id) !== player) return
    console.error('[audio] 起播失败', e)
    // 失败必须把条目摘掉，否则这路流再也重试不了（对端稍后才开始推是常态）。
    audioPlayers.delete(s.id)
    delete audioDown.value[s.id]
    if (streamFailureKind(s, e, !!url) === 'terminal') clearStreamError(s.id)
    else {
      blockRetry(s.id)
      streamError.value = {
        ...streamError.value,
        [s.id]: '这路声音连不上，正在重试',
      }
    }
  })
}

// 下行速率：三方无码率端点，唯一真源是播放器自己统计的接收速率。
const videoDown = ref<Record<string, number>>({})
const audioDown = ref<Record<string, number>>({})
const downlinkKbps = computed(() => subscribableStreams.value.reduce((total, stream) =>
  total + (stream.active ? (videoDown.value[stream.id] ?? 0) + (audioDown.value[stream.id] ?? 0) : 0), 0))
const downlinkText = computed(() => measuredRateText(downlinkKbps.value))


// 传输状态：全部来自播放器真实回调（onFrame 的 PTS+session、onTraffic 的字节、WHEP 的 getStats），
// 三方无码率/延迟端点。采集时间 = session.baseUnixNs + **微秒** PTS（帧在采集端的墙钟；
// 播放器已按容器时基换算过，见 recordVideoFrame）；播放时间 = 本地渲染墙钟。
interface StreamStat {
  pts: number; captureMs: number; playMs: number; delayMs: number
  decoded: number; bytes: number; w: number; h: number; fps: number
  /** 相对本次播放首帧的延迟漂移（带符号）；undefined = 基准还没立起来。 */
  driftMs?: number
  /** 漂移取自退化口径（轨道交付时刻而非帧时间戳），数值要标"估计"。 */
  driftEstimated?: boolean
  /** 源钟跳变导致的重锚次数。 */
  driftResets?: number
  /** 「真的在出声」：inbound-rtp.estimatedPlayoutTimestamp，0 = 拿不到。 */
  estimatedPlayoutEpochMs?: number
  /** 「轨道交付到这里」：同步源的投递时刻，0 = 拿不到。精度低于上一条，两者不许混用。 */
  trackDeliveryEpochMs?: number
  /** 上面两个量是哪一刻采的（performance.now）：两条轨的样本必须同时新鲜，隔太久的旧值相减不是差。 */
  playoutSampledAt?: number
}
const streamStats = ref<Record<string, StreamStat>>({})
// 一条腿一个漂移表：换腿/换源钟都要重立基准，所以它的生命周期跟播放器一致，不跟帧走。
const driftMeters = new Map<string, FrameDriftMeter>()
function recordDrift(id: string, sample: { sourceMs: number; observedMs: number; estimated?: boolean; clockId?: string }) {
  const meter = driftMeters.get(id) ?? new FrameDriftMeter()
  driftMeters.set(id, meter)
  const drift = meter.observe(sample)
  const prev = streamStats.value[id]
  if (!prev || drift === null) return
  streamStats.value = { ...streamStats.value, [id]: { ...prev, driftMs: drift.driftMs, driftEstimated: drift.estimated, driftResets: drift.resets } }
}
function recordVideoFrame(id: string, f: MediaFrame) {
  // 播放器交出来的 `timestamp` 已经是**微秒**：它在解封装时按容器时基换算过
  // （`pts * 1e6 / session.timebase`）。所以这里只除 1000，绝不能再除一次时基 ——
  // 曾经按 90 kHz 解释，等于把媒体时间放大 11.11 倍：采集时刻被算到未来 12 分钟，
  // 相对帧延迟读成 -807601 ms。
  const captureMs = Number(f.session?.baseUnixNs ?? 0n) / 1e6 + f.timestamp / 1000
  const playMs = performance.timeOrigin + performance.now()
  const prev = streamStats.value[id]
  streamStats.value = {
    ...streamStats.value,
    [id]: {
      pts: f.timestamp, captureMs, playMs, delayMs: playMs - captureMs,
      decoded: (prev?.decoded ?? 0) + 1, bytes: prev?.bytes ?? 0,
      // 分辨率与帧率取自帧头的会话描述，是采集端真实推出来的值
      w: f.session?.width || prev?.w || 0,
      h: f.session?.height || prev?.h || 0,
      fps: f.session?.fpsMilli ? f.session.fpsMilli / 1000 : prev?.fps || 0,
      driftMs: prev?.driftMs, driftEstimated: prev?.driftEstimated, driftResets: prev?.driftResets,
      // 直连腿不经 WebRTC，没有 PC 也没有接收方，这两个量**结构上取不到**，不是"还没取到"。
      estimatedPlayoutEpochMs: prev?.estimatedPlayoutEpochMs, trackDeliveryEpochMs: prev?.trackDeliveryEpochMs,
    },
  }
  // 直连腿的源时刻就在帧头里（会话基准 + 微秒 PTS），不需要问浏览器 —— 与 WHEP 腿共用同一个漂移口径。
  recordDrift(id, { sourceMs: captureMs, observedMs: performance.now(), clockId: String(f.session?.epoch ?? '') })
}
// 帧时刻表：只有走船端局域网那条腿的路有它（直连腿的采集时刻就在容器帧头里，浏览器自己拿得到）。
// 只轮询当前主画面那一路 —— 三方也是这么做的，全量轮询等于给船内网白加负载。
const frameTimes = new Map<string, FrameTimesSnapshot>()
const FRAME_TIMES_POLL_MS = 2000
let frameTimesStreamId = ''
let frameTimesTimer = 0

async function refreshFrameTimes(id: string) {
  if (!id || !frameTimesStreamId) return
  // silent 是这条轮询的硬性要求：它是诊断量，一次查不到就该安静地留「统计中」，
  // 不许变成弹窗 —— 每 2 秒打扰正在开会的人一次。
  const snap = await get<unknown>(`/api/v1/meetings/${meetingId}/streams/${encodeURIComponent(id)}/frame-times`, { silent: true })
    .then((res) => parseFrameTimes(res.data))
    .catch(() => null)
  // 查不到就什么都不做：这里不重试也不报错。
  if (snap && frameTimesStreamId === id) frameTimes.set(id, snap)
}

function watchFrameTimesFor(id: string) {
  if (frameTimesStreamId === id) return
  frameTimesStreamId = id
  if (frameTimesTimer) { window.clearInterval(frameTimesTimer); frameTimesTimer = 0 }
  if (!id) return
  void refreshFrameTimes(id)
  frameTimesTimer = window.setInterval(() => { void refreshFrameTimes(id) }, FRAME_TIMES_POLL_MS)
}

function stopFrameTimes() {
  if (frameTimesTimer) window.clearInterval(frameTimesTimer)
  frameTimesTimer = 0
  frameTimesStreamId = ''
}

/** 局域网 WHEP 腿的实测统计：这一路不经我方容器，每一项都只能从 PC 的 getStats 拿。 */
function recordLanWhepStats(id: string, st: WhepStats) {
  const prev = streamStats.value[id] ?? {
    pts: 0, captureMs: 0, playMs: 0, delayMs: 0, decoded: 0, bytes: 0, w: 0, h: 0, fps: 0,
  }
  // 采集时刻要拿"正在解的这一帧"的 RTP 时间戳去表里对同一帧；对不上就是 0，
  // 宁可这一格空着，也不报一个别的帧的采集时刻 —— 它会带着一个看起来很合理的假数进比对。
  const captureMs = captureEpochMsFor(frameTimes.get(id) ?? null, st.rtpTimestamp, st.clockRate)
  // 这两个量是"此刻播到哪"，不是累计值 —— 拿 30 秒前的旧样本去减今天的新样本会得出一个
  // 看起来很合理的假数，所以**原样覆盖**（这次没给就是 0），新旧由采样时刻去判，不靠"留着上次的"。
  const sampled = st.estimatedPlayoutEpochMs > 0 || st.trackDeliveryEpochMs > 0
  streamStats.value = {
    ...streamStats.value,
    [id]: {
      ...prev,
      bytes: st.bytesReceived, decoded: st.framesDecoded,
      w: st.width || prev.w, h: st.height || prev.h, fps: st.fps || prev.fps,
      estimatedPlayoutEpochMs: st.estimatedPlayoutEpochMs,
      trackDeliveryEpochMs: st.trackDeliveryEpochMs,
      playoutSampledAt: sampled ? performance.now() : prev.playoutSampledAt,
      captureMs: captureMs || prev.captureMs,
    },
  }
}
function setStreamBytes(id: string, bytes: number) {
  const prev = streamStats.value[id] ?? { pts: 0, captureMs: 0, playMs: 0, delayMs: 0, decoded: 0, bytes: 0, w: 0, h: 0, fps: 0 }
  streamStats.value = { ...streamStats.value, [id]: { ...prev, bytes } }
}
const uplinkBytes = ref(0)
// 统计条说的是**主画面那一格**，所以它的主体只能由 mainRow 决定。原先"没聚焦就取第一条
// 有统计的流"，默认进会时主画面是自己、统计条却报别人那一路的数字 —— 第 2 项要的正是错位消失。
const statIsSelf = computed(() => !!mainRow.value?.isSelf)
const statStreamId = computed(() => (statIsSelf.value ? SELF_FOCUS : mainRow.value?.streamId || ''))
const focusStat = computed<StreamStat | null>(() => {
  const id = statStreamId.value
  if (!id || id === SELF_FOCUS) return null
  return streamStats.value[id] ?? null
})
// 帧时刻表跟着主画面走：换一格就换一条 lane，继续轮询旧的等于查别人的槽。
watch(statStreamId, (id) => {
  const s = id && id !== SELF_FOCUS ? streams.value.find((x) => x.id === id) : null
  watchFrameTimesFor(isWhepVideoChannel(s?.videoChannel) ? id : '')
}, { immediate: true })

// 主画面下方状态栏（原型「主画面统计条」）：鼠标划过从下往上浮出，10 秒后从上往下收回。
const statBarOpen = ref(false)
let statBarTimer: number | null = null
function revealStatBar() {
  statBarOpen.value = true
  if (statBarTimer !== null) window.clearTimeout(statBarTimer)
  statBarTimer = window.setTimeout(() => { statBarOpen.value = false }, 10000)
}

const focusedStream = computed(() => {
  const id = statStreamId.value
  if (!id || id === SELF_FOCUS) return null
  return remoteStreams.value.find((s) => s.id === id) || null
})
const focusName = computed(() => focusedStream.value?.ownerName || '—')
const focusResolution = computed(() => {
  const s = focusStat.value
  return s && s.w && s.h ? s.w + '×' + s.h : '—'
})
const focusFps = computed(() => fpsText(focusStat.value?.fps))
const focusKbps = ref(0)

const focusedIsSelf = computed(() => statIsSelf.value)
const focusSelfStream = computed(() =>
  focusedIsSelf.value
    ? streams.value.find((x) => x.ownerId === myId.value && x.kind === (sharing.value && shareStream.value ? 'screen' : 'camera'))
    : undefined)
const focusSourceStream = computed(() =>
  focusedIsSelf.value
    ? focusSelfStream.value
    : streams.value.find((x) => x.id === statStreamId.value))
const selectedStatsId = ref('')
const publicLines = computed(() => streams.value.filter(s => s.transportMode && (s.kind === 'camera' || s.kind === 'screen')))
watch(publicLines, lines => {
  if (selectedStatsId.value && !lines.some(s => s.id === selectedStatsId.value)) selectedStatsId.value = ''
})
const statsLine = computed(() => publicLines.value.find(s => s.id === selectedStatsId.value)
  ?? publicLines.value.find(s => s.id === focusSourceStream.value?.id) ?? publicLines.value[0])
// Older media adapters report per-endpoint rates in their original format.
const legacyCompressionRatio = computed(() => {
  const stream = focusSourceStream.value
  if (!stream) return '—'
  const measurement = pickTransmittedKbps({ isSelfPublished: focusedIsSelf.value,
    ingressBitrateKbps: stream.ingressBitrateKbps, localReceivedKbps: focusKbps.value })
  return compressionView({ ...measurement, compressionKind: stream.compressionKind,
    sourceKbps: focusedIsSelf.value ? cameraUpKbps.value : stream.sourceBitrateKbps,
    reportedRatio: stream.compressionRatio, reportedEstimate: stream.compressionEstimated }).ratioText
})

watch([uplinkKbps, downlinkKbps], ([upKbps, downKbps]) => {
  meetingStore.setMediaStats({ upKbps, downKbps })
}, { immediate: true })

// 相对帧延迟 = 以本次播放收到的第一个有效帧为基准的漂移量：本地钟多走了多少、源时间只走了多少，
// 差出来的就是延迟在长（正）还是在追（负）。
// 为什么不报"播放时刻 − 采集时刻"那个绝对量：它要采集端墙钟，而局域网 WHEP 这条腿没有我方容器帧头；
// 三方在同一条腿上也只做相对量（其栏内说明原文："不代表绝对单向延迟"）。两条腿共用 mediaClock 一处实现。
const focusDelayText = computed(() => {
  if (focusedIsSelf.value) return '—'
  const st = focusStat.value
  if (st?.driftMs === undefined) return '统计中'
  return (st.driftEstimated ? '≈' : '') + (st.driftMs > 0 ? '+' : '') + st.driftMs.toFixed(0) + ' ms'
})
const focusDelayTitle = computed(() => {
  if (focusedIsSelf.value) return '本端是发送侧，没有时刻差可测'
  const st = focusStat.value
  if (st?.driftMs === undefined) return '还没收到可比的帧，取到之前不猜'
  if (st.driftEstimated) return '浏览器没给这一帧的时间戳，改用轨道交付时刻估计，不含后续呈现耗时'
  return '以本次播放首个有效帧为基准；正值表示延迟在长，负值表示在追赶，不代表绝对单向延迟'
})

// 播放音画差 = 这一路的画面播放时刻 − 同一个人独立音频路的播放时刻，两个数都取自本端 getStats，
// 不需要对端上报。正值=画面比声音晚（音频早）。三方在同一条局域网通道上就是这么给的。
// 找"同一个人的纯音频路"照三方那条判据（participantId 相同、有音、无画、活跃），
// 不许拿 mediaKind 猜 —— 画面自带音轨的那一路没有独立音频路，此时算不出就明说。
// 找"同一个人的纯音频路"必须在**全部流**里找：`remoteStreams` 只装视频瓦片
// （`filter(s => s.video …)`），纯音频发布永远不在里面 —— 搜错列表的后果是这一格恒等于
// "没有独立音频路"，而会里明明有那条流（2026-11-05 同会实测）。
const focusAudioMateId = computed(() => {
  const v = focusedStream.value
  return v ? findAudioMateId(streams.value, v.ownerId, v.id) : ''
})
const focusAudioStat = computed(() => {
  const id = focusAudioMateId.value
  return id ? streamStats.value[id] ?? null : null
})
// 两个样本必须是**同一时刻附近**的：一条轨死了半分钟、另一条还在报，相减会得到一个稳定的假差值。
const AV_SAMPLE_FRESH_MS = 2500
const focusAvSync = computed(() => {
  if (focusedIsSelf.value) return { text: '—', why: 'self' } as const
  const v = focusStat.value
  const a = focusAudioStat.value
  // 直连腿根本没有 PC，这两个量结构上取不到 —— 与"还没取到"是两件事，不许都写成统计中让人以为在等数。
  if (focusedStream.value?.videoChannel !== 'lanWhep') return { text: '—', why: 'no-pc' } as const
  if (!a) return { text: '—', why: 'no-audio-mate' } as const
  // 声音那条腿落在直连流上：没有 RTCPeerConnection，就没有"播放时刻"这个量 ——
  // 与"还没收到数据"是两件事，写"统计中"会让人一直等一个永远不来的数。
  if (audioLegKind.value[focusAudioMateId.value] === 'direct') return { text: '—', why: 'audio-direct' } as const
  // 同一口径才准相减：一方是"真的在出声"、一方只到"轨道交付"，差值里混着两个口径各自的偏差。
  const bothEstimated = (v?.estimatedPlayoutEpochMs ?? 0) > 0 && (a.estimatedPlayoutEpochMs ?? 0) > 0
  const bothDelivered = (v?.trackDeliveryEpochMs ?? 0) > 0 && (a.trackDeliveryEpochMs ?? 0) > 0
  if (!bothEstimated && !bothDelivered) return { text: '统计中', why: 'basis' } as const
  const now = performance.now()
  if (now - (v?.playoutSampledAt ?? 0) > AV_SAMPLE_FRESH_MS || now - (a.playoutSampledAt ?? 0) > AV_SAMPLE_FRESH_MS) {
    return { text: '统计中', why: 'stale' } as const
  }
  const d = bothEstimated
    ? (v?.estimatedPlayoutEpochMs ?? 0) - (a.estimatedPlayoutEpochMs ?? 0)
    : (v?.trackDeliveryEpochMs ?? 0) - (a.trackDeliveryEpochMs ?? 0)
  return { text: (bothEstimated ? '' : '≈') + (d > 0 ? '+' : '') + d.toFixed(0) + ' ms', why: 'ok', d, estimated: !bothEstimated } as const
})
const focusAvSyncText = computed(() => focusAvSync.value.text)
const focusAvSyncTitle = computed(() => {
  const r = focusAvSync.value
  if (r.why === 'self') return '本端不比较自己的音画，这一格留空'
  if (r.why === 'no-pc') return '这一路的画面不经浏览器实时通道，本端量不到播放时刻'
  if (r.why === 'no-audio-mate') return '这一路的画面自带声音，没有独立音频路可比'
  if (r.why === 'audio-direct') return '这一路的声音走的是直连通道，量不到播放时刻，所以比不出音画差'
  if (r.why === 'basis') return '两条轨还没给出同一个口径的播放时刻，口径不同相减出来的不是差'
  if (r.why === 'stale') return '有一条轨的播放时刻已经停止更新，拿旧值相减出来的不是差'
  const basis = r.estimated ? '（轨道交付时刻，非实际出声）' : ''
  return `画面播放时刻 − 声音播放时刻${basis}：${Math.abs(r.d) <= 80 ? '基本同步' : r.d > 0 ? '音频早' : '音频晚'}`
})

// 旧媒体适配器使用本机播放器字节计数测量所选远端视频的接收速率。
let ratePrev = { id: '', bytes: 0, at: 0 }
function sampleFocusRate() {
  const id = focusedStream.value?.id || ''
  const st = id ? streamStats.value[id] : null
  const now = performance.now()
  if (!st) {
    focusKbps.value = 0
    ratePrev = { id: '', bytes: 0, at: now }
    return
  }
  if (ratePrev.id === id && now > ratePrev.at && st.bytes >= ratePrev.bytes) {
    // Δbytes*8 ÷ Δms 就是 SI kbit/s（与三方 `samplePeerRates` 的采样公式逐字同形）。
    focusKbps.value = Math.round(((st.bytes - ratePrev.bytes) * 8) / (now - ratePrev.at))
  }
  ratePrev = { id, bytes: st.bytes, at: now }
}


watch(subscribableStreams, attachRemoteStreams, { deep: false })

// 有人开始共享屏幕 → 顶成主画面并聚焦。三方会饿着没人关注的流（实测不 focus 只有 ~70kbps、
// 首字节 700ms+），所以既改视觉主画面，也顺带把关注上报上去。
watch(sharing, (on) => {
  // 共享开始后主画面切到共享内容（本端看自己的屏幕轨，对端看共享流）。
  if (on) {
    layout.value = 'top'
    focusedId.value = SELF_FOCUS
  }
})

watch(shareStreamId, (id) => {
  if (id && id !== focusedId.value) void focus(id)
})

// 换排列会重建瓦片：canvas 是新的 DOM 元素，老播放器还画在已脱离文档的旧 canvas 上，
// 表现就是"切一下排列全屏黑"。所以拆掉重订阅。
function rebuildVideoPlayers() {
  for (const p of videoPlayers.values()) p.stop()
  videoPlayers.clear()
  playerCanvases.clear()
  retryBlockedUntil.clear()
  void nextTick(() => attachRemoteStreams())
}

watch(layout, () => {
  railOpen.value = true
  // 右侧面板只属于"右侧排列"：切到顶部/宫格时把它收掉，成员位置由排列本身决定。
  if (dock.value === 'members') dock.value = 'none'
  rebuildVideoPlayers()
})

// 右侧排列下，视频 canvas 在主画面与成员面板之间随聚焦/收展换位，播放器必须跟着重建；
// 其余排列的 canvas 一直在瓦片上，不需要。
watch([panelVisible, focusedId], () => {
  if (layout.value === 'right') rebuildVideoPlayers()
})

// 会议结束的总出口：会话态一被清（WS 收到终态、REST 报终态、对端把会停了）就拆链路并离开，
// 而不是留在会中页等用户自己去点。
watch(() => meetingStore.inMeeting, (inMeeting) => {
  if (inMeeting) return
  stopTicker()
  ws.disconnect()
  void router.replace('/meeting-empty')
})

// 媒体意图必须送达才算上报过：attachSelfMedia 里那次往往赶上 WS 还没连上，
// ws.send 在未连接时是静默丢弃的 —— 上游就会一直以为我们没开麦（对端据此不混我们的音频）。
// 连上（含断线重连）后补一次当前状态。
watch(() => ws.connected.value, (on) => {
  if (on) void pushMediaState()
})

// 会议从"待开始"转为可推流：补上入会时欠下的那次发布，用户不必再手动开关一遍。
watch(canPublish, (ok) => {
  if (!ok || !pendingSelfPublish) return
  pendingSelfPublish = false
  if (stageNotice.value.startsWith('会议尚未开始')) stageNotice.value = ''
  void publishSelfLanes()
})

onMounted(() => {
  loadInitial()
  registerRecordingProviders({
    desiredTracks: () => desiredTracks(),
    context: () => ({
      userName: recordingUserName(),
      // 会议号只有三方那一个来源，而没拿到号在预检页就被拦下（`PreMeetingView` 的「这场会还没准备好」），
      // 所以正常路径上这里恒是真号；`|| meetingId` 只兜"深链直进且没会话态"那种异常，不是第二种号
      meetingNo: String(meetingStore.meetingNo || meetingId),
      title: meetingStore.title || '会议',
      recordingQuality: media.prefs.value?.recordingQuality,
      recordingFps: media.prefs.value?.recordingFps,
    }),
  })
})
onBeforeUnmount(() => {
  stopTicker()
  faceRoi.dispose()
  stopFrameTimes()
  unregisterRecordingProviders()
})
</script>

<style scoped>
.im-root {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--bg-dark);
}

/* 顶部状态条 */
.im-topbar {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 16px;
  /* 固定高 + 速率条 flex-wrap 是"第二行溢出压住画面"的成因：让条子随内容长，别裁。 */
  min-height: 54px;
  padding: 6px 18px;
  background: var(--bg-card);
  border-bottom: 1px solid var(--border-soft);
}
.im-top-left { display: flex; align-items: center; gap: 8px; min-width: 0; flex: 1; flex-wrap: wrap; }
.im-title {
  font-size: 15px; font-weight: 600; color: var(--text-primary);
  /* 主题完整展示：允许换行，不再用窄 max-width 截成省略号。 */
  white-space: normal;
  overflow: visible;
  word-break: break-word;
  line-height: 1.35;
  flex: 1 1 auto;
  min-width: 0;
}
.im-badge {
  flex-shrink: 0; padding: 1px 8px; border-radius: var(--radius-pill);
  font-size: 11px; line-height: 18px;
}
.im-badge-run { background: rgba(34, 197, 94, 0.12); color: var(--success-text); }
.im-badge-idle { background: var(--bg-hover); color: var(--text-tertiary); }
.im-badge-rec { background: var(--danger-bg); color: var(--danger-text); }
.im-badge-kind { background: var(--primary-soft); color: var(--primary-text); }

.im-top-right { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
.im-layout-btn {
  display: inline-flex; align-items: center; gap: 2px;
  height: 30px; padding: 0 8px; font-size: 15px; color: var(--text-secondary);
  background: var(--bg-input); border: 1px solid var(--border-color);
  border-radius: 8px; cursor: pointer;
}
.im-layout-btn:hover { color: var(--primary-text); border-color: var(--primary); }
.im-layout-chev { font-size: 13px; color: var(--text-muted); }
.im-layout-menu-ic { margin-right: 6px; }
.im-icon-btn {
  width: 30px; height: 30px; border: 0; border-radius: 8px; background: transparent;
  color: var(--text-tertiary); cursor: pointer; font-size: 15px;
}
.im-icon-btn:hover { background: var(--bg-hover); color: var(--text-primary); }

/* 主体 */
.im-main { flex: 1; display: flex; min-height: 0; position: relative; }
.im-stage {
  flex: 1; display: flex; flex-wrap: wrap; align-content: center; justify-content: center;
  gap: 14px; padding: 18px; min-width: 0; overflow-y: auto;
}
/* 主画面统计条（第3项）：挂在主画面窗格内部（.im-tile 本身 relative + overflow hidden），
   贴在窗格下沿、不越过窗格边界；平时藏在窗格下沿外，鼠标划过从下往上浮出，10 秒后原路收回。 */
.im-statbar {
  position: absolute; left: 0; right: 0; bottom: 0; z-index: 6;
  display: flex; flex-wrap: wrap; gap: 14px;
  padding: 8px 12px;
  background: rgba(15, 23, 42, 0.55);
  transform: translateY(100%);
  /* 只靠 translateY 收下去并不等于"藏起来"：窗格的 overflow 会把它算进可滚动区域，
     实测收起后那条半透明带子还压在下方工具条上。补 opacity/visibility 才是真收起。 */
  opacity: 0; visibility: hidden;
  transition: transform 0.28s ease, opacity 0.28s ease, visibility 0s linear 0.28s;
  pointer-events: none;
}
.im-statbar.open { transform: translateY(0); opacity: 1; visibility: visible; transition: transform 0.28s ease, opacity 0.28s ease; }
.im-statbar-item { display: flex; flex-direction: column; gap: 2px; min-width: 68px; }
.im-statbar-item .k { font-size: 11px; color: #94a3b8; }
.im-statbar-item .v { font-size: 12px; font-weight: 600; color: #fff; }
/* 宫格里充当主画面的聚焦格只有半幅宽：统计条再收一档字号与占位，
   让十项在格内收拢浮出，不越过格边界压到别的格上。 */
.im-stage-grid .im-statbar { gap: 10px; padding: 6px 10px; }
.im-stage-grid .im-statbar-item { min-width: 56px; }
.im-stage-grid .im-statbar-item .k { font-size: 10px; }
.im-stage-grid .im-statbar-item .v { font-size: 11px; }

.im-stage-grid { align-content: start; }
/* 原型宫格：558×320 两列 */
.im-stage-grid .im-tile { flex: 1 1 calc(50% - 7px); height: 320px; }

/* 宫格里的"没画面"那一格：原型用头像占位 + 一行摄像头已关闭提示，
   不是把这个人从格子里去掉。 */
.im-tile-avatar {
  position: absolute; inset: 0;
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 10px; background: var(--bg-hover);
}
.im-tile-avatar img {
  width: 64px; height: 64px; border-radius: 50%; object-fit: cover;
}
.im-tile-avatar-char {
  width: 64px; height: 64px; display: flex; align-items: center; justify-content: center;
  border-radius: 50%; background: var(--primary); color: #fff; font-size: 24px;
}
.im-tile-avatar-hint { margin: 0; font-size: 12px; color: var(--text-tertiary); }

/* 顶部排列（原型 15_meeting_top2.png）：上边一条缩略条**包含主画面那位**（那一格带蓝描边），
   下方整幅主画面。第3项把缩略条从原型的 368px 收窄到 224px 一档（高度同比收窄），
   仍容得下 foot 的「名称行 + 总上行/总下行两列」；主画面那一格由 .im-tile-main 标记。
   缩略条里有流的一格渲染画面（第4项修复：不再恒显头像），主画面那位的镜像格显示主画面帧的拷贝。 */
.im-stage-top { flex-direction: column; flex-wrap: nowrap; align-content: stretch; align-items: stretch; justify-content: flex-start; }
/* 缩略条恒为一行（原型就是一行成员卡），成员多到放不下时横向滚动；
   主画面那一组吃掉剩下的全部高度。原先写死 calc(100% - 135px) 只按单行算，
   实测四人时缩略条换成四行、主画面被顶到 y=502 直接掉出舞台。 */
.im-stage-top .im-stage-strip { flex: 0 0 auto; display: flex; flex-wrap: nowrap; gap: 12px; overflow-x: auto; overflow-y: hidden; }
.im-stage-top .im-stage-main-row { flex: 1 1 auto; display: flex; min-height: 0; }
.im-stage-group.is-contents { display: contents; }
.im-stage-top .im-tile:not(.im-tile-main) {
  flex: 0 0 224px; height: 84px; order: 1;
  display: flex; align-items: center; gap: 8px; padding: 8px 10px;
}
.im-stage-top .im-tile:not(.im-tile-main) .im-video { flex: 0 0 84px; width: 84px; height: 60px; border-radius: 6px; }
.im-stage-top .im-tile:not(.im-tile-main) .im-tile-avatar {
  position: static; flex: 0 0 84px; width: 84px; height: 60px; gap: 3px; border-radius: 6px;
}
.im-stage-top .im-tile:not(.im-tile-main) .im-tile-avatar img,
.im-stage-top .im-tile:not(.im-tile-main) .im-tile-avatar-char { width: 26px; height: 26px; font-size: 13px; }
.im-stage-top .im-tile:not(.im-tile-main) .im-tile-avatar-hint { font-size: 10px; line-height: 1.2; }
/* 主画面那一格：关摄像头后头像必须铺满整幅居中，
   否则 84×60 的小图会贴在左上角，看着像画面坏了（实测偏移 -244/-178）。 */
.im-stage-top .im-tile-main .im-tile-avatar {
  position: absolute; inset: 0; width: auto; height: auto;
  flex-direction: column; align-items: center; justify-content: center; gap: 10px;
}
.im-stage-top .im-tile-main .im-tile-avatar img,
.im-stage-top .im-tile-main .im-tile-avatar-char { width: 64px; height: 64px; font-size: 24px; }
.im-stage-top .im-tile-main .im-tile-avatar-hint { font-size: 12px; line-height: 1.4; }
.im-stage-top .im-tile:not(.im-tile-main) .im-tile-foot {
  position: static; flex: 1; min-width: 0; flex-direction: column; align-items: flex-start;
  gap: 3px; padding: 0; background: none;
}
.im-stage-top .im-tile:not(.im-tile-main) .im-tile-rate { gap: 10px; }
/* 原型缩略条：两列各是「小灰标签 + 下面一行数值」，不是宫格那种 ↑/↓ 一行。
   224px 的窄格按 .im-tile-strip 档收紧标签与数值的字号。 */
.im-rate-col { display: flex; flex-direction: column; gap: 2px; min-width: 60px; }
.im-rate-col i { font-style: normal; font-size: 11px; color: var(--text-tertiary); }
.im-rate-col b { font-weight: 600; font-size: 12px; color: inherit; }
.im-tile-strip .im-tile-line { flex-wrap: nowrap; }
.im-tile-strip .im-rate-col { min-width: 0; }
.im-tile-strip .im-rate-col i { font-size: 10px; white-space: nowrap; }
.im-tile-strip .im-rate-col b { font-size: 11px; white-space: nowrap; }
.im-tile-strip .im-tile-name { max-width: 64px; }
.im-stage-top .im-tile-main {
  flex: 1 1 auto;
  min-height: 320px;
  display: block; padding: 0;
}
.im-stage-top .im-tile-main .im-video { width: 100%; height: 100%; border-radius: 0; }
/* 第3项：主画面窗格不渲染 .im-tile-foot（只留悬浮统计条），这里不再有主画面格的 foot 规则。 */
/* 原型：缩略条里"此刻占着主画面"那一格带蓝描边 */
.im-tile.is-inmain { border-color: var(--primary); }

/* 右侧排列（原型：主画面卡 836 + 独立成员面板）：舞台只留一块主画面，
   成员缩略图归 280 面板管，不在这里再排一列。 */
.im-stage-right { align-content: start; }
.im-stage-right .im-tile { flex: 1 1 100%; height: 100%; min-height: 320px; }

/* 共享屏幕中（原型第四种呈现，独立于所选排列）：缩略条在上（112×79），共享内容独占主画面。
   进入该形态时脚本会把共享流顶成聚焦块，所以这里只需覆盖尺寸与顺序。
   顶部排列的缩略条本身就在上面且已有原型宽度，不套这条 112px 规则。 */
.im-stage.is-sharing:not(.im-stage-top) { align-content: start; }
.im-stage.is-sharing:not(.im-stage-top) .im-tile { flex: 0 0 112px; height: 79px; order: 1; }
/* 聚焦/共享那一路顶成主画面，但**顶部排列的缩略条那一格不能跟着顶大**：
   它在自己的容器里，主画面另有同一位的另一格（否则缩略条里会插进一块 100% 宽的巨卡）。 */
.im-stage.is-sharing .im-tile.focused:not(.im-tile-strip),
.im-stage.is-sharing .im-tile.im-tile-share:not(.im-tile-strip) {
  flex: 1 1 100%;
  /* 主画面吃掉缩略条行以外的整幅高度；原先写死 calc(100% - 135px) 是按旧
     368×107 缩略条算的，缩略条改窄一档后会在主画面下多出一条空带。 */
  height: 100%;
  min-height: 320px;
  order: 2;
  display: block; padding: 0;
}

/* 原型「运行状态条」：图标底 + 字段名 + 实测值 */
.im-runbar {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.im-run {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 5px 10px;
  border-radius: 9px;
  background: var(--bg-hover);
  font-size: 12px;
  color: var(--text-secondary);
  /* 原型每列是定宽文本层：值不伸缩，前面的参数变长也不能挤压后面的（第25项） */
  flex-shrink: 0;
}

.im-run-icon {
  width: 20px;
  height: 20px;
  border-radius: 6px;
  background: var(--primary-soft);
  color: var(--primary-text);
  font-style: normal;
  font-size: 12px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.im-run-k { color: var(--text-muted); flex-shrink: 0; }
.im-run b { color: var(--text-primary); font-weight: 600; display: inline-block; min-width: 66px; }

.im-badge-share { background: var(--primary-soft); color: var(--primary-text); }
.im-badge-warn { background: var(--warning-bg, #fff7e8); color: var(--orange, #f59e0b); }

.im-tile {
  position: relative; width: 300px; aspect-ratio: 16 / 10; background: #1e293b;
  border-radius: var(--radius-lg); overflow: hidden; cursor: pointer;
  border: 2px solid transparent;
}
.im-tile.focused { border-color: var(--primary); }
.im-video { width: 100%; height: 100%; object-fit: cover; background: #1e293b; }
/* 原型格底半透明名牌：rgba(15,23,42,.55) */
.im-tile-foot {
  position: absolute; left: 0; right: 0; bottom: 0; display: flex; flex-direction: column; align-items: flex-start; gap: 2px;
  padding: 10px; font-size: 12px; color: #fff;
  background: rgba(15, 23, 42, 0.55);
}
.im-tile-line { display: flex; align-items: center; gap: 6px; min-width: 0; max-width: 100%; flex-wrap: wrap; }
.im-tile-name { min-width: 0; max-width: 160px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-weight: 500; }
.im-tile-media { display: inline-flex; gap: 4px; font-size: 15px; }
.im-tile-media .ri-mic-off-line, .im-tile-media .ri-video-off-line { opacity: 0.55; }
.im-tile-rate { display: flex; gap: 10px; font-size: 12px; color: #cbd5e1; font-variant-numeric: tabular-nums; }
.im-tile-spec { font-style: normal; color: var(--text-tertiary); }
/* 名牌上的 边/云、主持人、正在讲话 小标签（原型 18px 高） */
.im-chip {
  flex-shrink: 0; min-width: 18px; height: 18px; padding: 0 5px; box-sizing: border-box;
  border-radius: var(--radius-sm); font-size: 11px; line-height: 18px; text-align: center; font-weight: 400;
}
.im-chip-edge { background: rgba(34, 197, 94, 0.22); color: #86efac; }
.im-chip-cloud { background: rgba(148, 163, 184, 0.28); color: #e2e8f0; }
.im-chip-host { background: rgba(217, 119, 6, 0.28); color: #fcd34d; }
.im-chip-speak { background: rgba(22, 93, 255, 0.35); color: #bfdbfe; }
.im-off { font-size: 11px; color: #fecaca; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.im-speaking {
  position: absolute; inset: 0; border: 2px solid var(--success);
  border-radius: var(--radius-lg); pointer-events: none;
}
/* 宫格末尾的「空位-邀请成员」格（原型：56 圆图标 + 复制邀请链接按钮） */
.im-tile-invite {
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px;
  background: var(--bg-hover); cursor: default;
}
.im-invite-ic {
  width: 56px; height: 56px; border-radius: 50%; background: var(--bg-card);
  border: 1px dashed var(--border-color);
  display: flex; align-items: center; justify-content: center;
  font-size: 24px; color: var(--primary-text);
}
.im-invite-title { font-size: 14px; color: var(--text-secondary); font-weight: 500; }
.im-invite-sub { margin-top: -6px; font-size: 12px; color: var(--text-tertiary); }
.im-invite-btn {
  height: 32px; padding: 0 16px; border: 1px solid var(--border-color); border-radius: var(--radius);
  background: var(--bg-card); color: var(--text-secondary); font-size: 12px; cursor: pointer;
}
.im-invite-btn:hover { border-color: var(--primary); color: var(--primary-text); }
.im-stage-hint {
  width: 100%; text-align: center; padding: 40px 20px; font-size: 13px; color: var(--text-muted);
}

/* 底部控制条 */
.im-controls {
  flex-shrink: 0; display: flex; align-items: center; gap: 14px;
  /* 与控制条同源的坑：固定高 + 中间那组 flex-wrap，窄屏下按钮换行会溢出压住画面。 */
  min-height: 66px; padding: 6px 16px; background: var(--bg-card);
  border-top: 1px solid var(--border-soft);
}
.im-strategy { display: flex; flex-direction: column; gap: 3px; flex-shrink: 0; }
.im-strategy-item { display: flex; align-items: center; gap: 6px; font-size: 11px; color: var(--text-muted); }
.im-strategy-item select {
  height: 26px; padding: 0 6px; font-size: 11px; color: var(--text-secondary);
  background: var(--bg-input); border: 1px solid var(--border-color); border-radius: 6px;
  outline: none; cursor: pointer; max-width: 168px;
}
.im-strategy-item select:disabled { color: var(--text-muted); cursor: not-allowed; }

.im-ctl-center { display: flex; align-items: center; gap: 6px; flex: 1; justify-content: center; flex-wrap: wrap; }
.im-ctl-right { display: flex; gap: 8px; flex-shrink: 0; }
/* 原型控制键：remixicon 图标在上、文字在下 */
.im-btn {
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 3px;
  min-width: 56px; height: 54px; padding: 0 10px; border: 1px solid transparent; border-radius: var(--radius);
  background: var(--bg-input); color: var(--text-secondary); font-size: 11px;
  cursor: pointer; white-space: nowrap;
}
.im-btn > i { font-size: 18px; font-style: normal; }
.im-btn:hover { background: var(--bg-hover); color: var(--text-primary); }
.im-btn-off { background: var(--danger-bg); color: var(--danger-text); border-color: var(--danger-border); }
.im-btn-on { background: var(--primary-soft); color: var(--primary-text); }
.im-btn-leave { background: #fff; border-color: var(--border-color); color: var(--text-secondary); }
.im-btn-leave:hover { border-color: var(--danger); color: var(--danger-text); background: var(--danger-bg); }
.im-btn-end { background: var(--danger); color: #fff; }
.im-btn-end:hover { background: #dc2626; color: #fff; }
.im-stats { width: 268px; flex-shrink: 0; display: flex; flex-direction: column; border-left: 1px solid var(--border-color); background: var(--bg-card); overflow-y: auto; }
.im-dock-head { display: flex; align-items: center; justify-content: space-between; padding: 14px; font-size: 14px; }
.im-x { border: 0; background: transparent; color: var(--text-secondary); cursor: pointer; font-size: 14px; }
.im-stats-body { padding: 0 14px 14px; font-size: 13px; }
.im-stats-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 12px; }
.im-stats-grid > div { display: flex; flex-direction: column; gap: 2px; padding: 8px; border-radius: var(--radius); background: rgba(127, 127, 127, 0.08); }
.im-stats-row { display: flex; justify-content: space-between; padding: 6px 0; border-bottom: 1px dashed var(--border-color); }
.im-stats .k { color: var(--text-secondary); }
.im-stats .v { font-variant-numeric: tabular-nums; }
.im-stats-empty { color: var(--text-secondary); text-align: center; padding: 16px 0; }

/* ── 语音对讲舞台：头像 + 卫通云连接 ─────────────────────────────────────── */
.im-stage-voice {
  align-content: center;
  justify-content: center;
  background:
    radial-gradient(ellipse at 50% 42%, rgba(22, 93, 255, 0.16), transparent 55%),
    var(--bg-dark);
}
.voice-stage {
  width: min(720px, 92%);
  margin: auto;
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: min(62vh, 520px);
}
.voice-orbit {
  position: relative;
  width: 100%;
  min-height: 420px;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: center;
  gap: 28px 48px;
  padding: 48px 24px 32px;
}
.voice-cloud {
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  width: 120px;
  height: 120px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  z-index: 1;
  pointer-events: none;
}
.voice-cloud-ring {
  position: absolute;
  inset: 0;
  border-radius: 50%;
  border: 1px solid rgba(77, 139, 255, 0.45);
  animation: voicePulse 2.4s ease-out infinite;
}
.voice-cloud-ring.delay { animation-delay: 1.2s; }
.voice-cloud-ic {
  font-size: 36px;
  color: #4d8bff;
  filter: drop-shadow(0 0 12px rgba(77, 139, 255, 0.55));
}
.voice-cloud-label {
  font-size: 13px;
  font-weight: 650;
  color: #c7d7ff;
  letter-spacing: 0.06em;
}
@keyframes voicePulse {
  0% { transform: scale(0.72); opacity: 0.7; }
  100% { transform: scale(1.55); opacity: 0; }
}
.voice-peer {
  position: relative;
  z-index: 2;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  min-width: 140px;
  padding: 8px;
}
.voice-peer-link {
  position: absolute;
  left: 50%;
  top: 50%;
  width: 2px;
  height: 64px;
  background: linear-gradient(180deg, transparent, rgba(77, 139, 255, 0.55), transparent);
  transform-origin: center top;
  pointer-events: none;
  opacity: 0.7;
}
.voice-peer.remote .voice-peer-link {
  transform: translate(-50%, -120%) rotate(180deg);
  height: 72px;
}
.voice-peer.self .voice-peer-link {
  transform: translate(-50%, 20%);
  height: 72px;
}
.voice-orbit:not(.has-peer) .voice-peer-link { display: none; }
.voice-peer-avatar {
  width: 96px;
  height: 96px;
  border-radius: 50%;
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
  background: linear-gradient(145deg, #1e3a8a, #165dff);
  color: #fff;
  font-size: 36px;
  font-weight: 650;
  box-shadow: 0 0 0 3px rgba(77, 139, 255, 0.35), 0 12px 28px rgba(0, 0, 0, 0.28);
}
.voice-peer.speaking .voice-peer-avatar {
  box-shadow: 0 0 0 4px rgba(34, 197, 94, 0.55), 0 12px 28px rgba(0, 0, 0, 0.28);
  animation: voiceSpeak 1.1s ease-in-out infinite;
}
@keyframes voiceSpeak {
  0%, 100% { transform: scale(1); }
  50% { transform: scale(1.04); }
}
.voice-peer-avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.voice-peer-name {
  font-size: 16px;
  font-weight: 650;
  color: var(--text-primary);
  max-width: 160px;
  text-align: center;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.voice-peer-meta {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: var(--text-muted);
}
.voice-peer.speaking .voice-peer-meta { color: var(--success-text, #4ade80); }
.voice-waiting {
  position: absolute;
  left: 50%;
  bottom: 28px;
  transform: translateX(-50%);
  text-align: center;
  z-index: 2;
}
.voice-waiting p {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  color: var(--text-primary);
}
.voice-waiting span {
  display: block;
  margin-top: 6px;
  font-size: 13px;
  color: var(--text-muted);
}
.im-btn-primary-share {
  background: var(--primary);
  color: #fff;
  border-color: var(--primary);
}

/* 共享中悬浮条（腾讯会议同类：预览 + 文案 + 停止） */
.share-float {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 0 16px 8px;
  padding: 8px 12px;
  border-radius: 12px;
  background: rgba(15, 23, 42, 0.92);
  border: 1px solid rgba(255, 255, 255, 0.08);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.28);
  color: #fff;
}
.share-float-preview {
  width: 72px;
  height: 42px;
  border-radius: 6px;
  overflow: hidden;
  background: #0f172a;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.share-float-preview i { font-size: 18px; color: #94a3b8; }
.share-float-video {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.share-float-copy {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.share-float-copy b {
  font-size: 13px;
  font-weight: 650;
}
.share-float-copy span {
  font-size: 12px;
  color: #94a3b8;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.share-float-stop {
  flex-shrink: 0;
  height: 32px;
  padding: 0 14px;
  border: 0;
  border-radius: 8px;
  background: #ef4444;
  color: #fff;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}
.share-float-stop:hover { background: #dc2626; }

/* ── 平板 ─────────────────────────────────────────────────────────────────
   侧栏已收成图标栏；控制条略收字号；抽屉覆盖画面，不抢主区宽度。 */
.im-root.is-tablet .im-run-detail { display: none; }
.im-root.is-tablet .im-btn { min-width: 48px; height: 50px; padding: 0 8px; font-size: 10px; gap: 2px; }
.im-root.is-tablet .im-btn > i { font-size: 17px; }
.im-root.is-tablet .im-stage { padding: 12px; gap: 10px; }
.im-root.is-tablet .im-stats {
  position: absolute; top: 0; right: 0; bottom: 0; z-index: 8;
  width: min(320px, 42vw); border-left: 1px solid var(--border-color);
  background: var(--bg-card);
  box-shadow: -8px 0 24px rgba(0, 0, 0, 0.18);
}

/* ── 手机：稳参会优先 —— 少信息、大气口、底栏主控 ───────────────────────── */
.im-root.is-phone {
  padding-bottom: var(--safe-bottom);
}
.im-root.is-phone .im-topbar {
  min-height: 48px;
  padding: 8px 12px;
  padding-top: calc(8px + var(--safe-top));
  gap: 8px;
}
.im-root.is-phone .im-title {
  font-size: 14px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  word-break: normal;
  flex: 1 1 auto;
}
.im-root.is-phone .im-badge-desk { display: none; }
.im-root.is-phone .im-top-left { flex-wrap: nowrap; gap: 6px; }
.im-root.is-phone .im-stage {
  padding: 8px;
  gap: 8px;
  align-content: stretch;
}
.im-root.is-phone .im-stage-grid .im-tile {
  flex: 1 1 100%;
  height: auto;
  min-height: min(38vh, 280px);
  border-radius: 14px;
}
.im-root.is-phone .im-tile-rate,
.im-root.is-phone .im-statbar,
.im-root.is-phone .im-chip-edge,
.im-root.is-phone .im-chip-cloud,
.im-root.is-phone .im-tile-invite {
  display: none !important;
}
.im-root.is-phone .im-controls {
  min-height: 72px;
  padding: 8px 10px calc(8px + var(--safe-bottom));
  gap: 8px;
  justify-content: space-between;
}
.im-root.is-phone .im-ctl-center {
  flex-wrap: nowrap;
  justify-content: flex-start;
  gap: 8px;
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;
  scrollbar-width: none;
}
.im-root.is-phone .im-ctl-center::-webkit-scrollbar { display: none; }
.im-root.is-phone .im-btn {
  min-width: 56px;
  height: 56px;
  padding: 0 8px;
  font-size: 11px;
  gap: 4px;
  border-radius: 14px;
  flex-shrink: 0;
}
.im-root.is-phone .im-btn > i { font-size: 20px; }
.im-root.is-phone .im-btn-leave {
  background: var(--danger);
  border-color: transparent;
  color: #fff;
  min-width: 64px;
}
.im-root.is-phone .im-btn-leave:hover {
  background: #dc2626;
  color: #fff;
}
.im-root.is-phone .share-float {
  left: 12px;
  right: 12px;
  bottom: calc(88px + var(--safe-bottom));
  width: auto;
  max-width: none;
}
.im-root.is-phone .voice-orbit {
  min-height: min(58vh, 420px);
  padding: 32px 12px 24px;
  gap: 20px;
}
.im-root.is-phone .voice-cloud {
  transform: translate(-50%, -52%) scale(0.88);
}

/* 手机：成员 / 聊天 / 传输状态 → 底部抽屉，不抢画面宽度 */
.im-root.is-phone :deep(.mp),
.im-root.is-phone :deep(.cp),
.im-root.is-phone .im-stats {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  top: auto;
  z-index: 12;
  width: 100% !important;
  max-height: min(62vh, 520px);
  border-left: 0;
  border-top: 1px solid var(--border-soft);
  border-radius: 18px 18px 0 0;
  box-shadow: 0 -12px 40px rgba(0, 0, 0, 0.28);
  animation: im-sheet-up 0.28s cubic-bezier(0.22, 1, 0.36, 1);
}
.im-root.is-phone :deep(.mp-rate-row) { display: none; }
.im-root.is-phone :deep(.mp-thumb) {
  width: 44px;
  height: 44px;
}
@keyframes im-sheet-up {
  from { transform: translateY(16px); opacity: 0.6; }
  to { transform: translateY(0); opacity: 1; }
}

/* 平板竖屏：宫格单列，避免两格挤成指甲盖 */
@media (max-width: 820px) {
  .im-root.is-tablet .im-stage-grid .im-tile {
    flex: 1 1 100%;
    height: min(42vh, 260px);
  }
  .im-root.is-tablet :deep(.mp),
  .im-root.is-tablet :deep(.cp) {
    position: absolute;
    top: 0; right: 0; bottom: 0; z-index: 8;
    width: min(300px, 78vw) !important;
    box-shadow: -8px 0 24px rgba(0, 0, 0, 0.18);
  }
}
</style>
