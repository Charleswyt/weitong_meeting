/**
 * 卫通会议（Web）用户协议与隐私政策 —— 本产品自有文案（中/英）。
 * 结构借鉴常见会议类 Web 产品的章节安排，内容按本系统（浏览器端控制面）重写，
 * 不引用无关品牌、不描述桌面程序安装/更新/本地守护进程等特征。
 */

export type LegalDocId = 'terms' | 'privacy'
export type LegalLocale = 'zh' | 'en'

export interface LegalDoc {
  id: LegalDocId
  title: string
  updatedAt: string
  sections: { heading: string; paragraphs: string[] }[]
}

const TERMS_ZH: LegalDoc = {
  id: 'terms',
  title: '卫通会议用户协议',
  updatedAt: '2026-11-20',
  sections: [
    {
      heading: '一、协议适用范围',
      paragraphs: [
        '本协议是您与卫通会议提供方（以下简称「我们」）之间，就您通过浏览器访问和使用卫通会议网页端（以下简称「本产品」）所订立的约定。',
        '您打开本产品页面、注册或登录账号、发起或加入会议、使用录制与回放等功能，即表示您已阅读并同意本协议。如不同意，请停止使用。',
      ],
    },
    {
      heading: '二、产品说明',
      paragraphs: [
        '本产品是基于浏览器的视频会议与会务管理能力，用于船岸及跨站点协同沟通。音视频传输、转码与部分会控能力可能由经授权的协作媒体平台承载；页面编排、账号会话与业务数据由本产品控制面提供。',
        '本产品通过网页提供，您使用常见浏览器即可访问。功能以页面实际开放范围为准，并可能随版本迭代调整。',
      ],
    },
    {
      heading: '三、账号与安全',
      paragraphs: [
        '您应妥善保管登录凭证（账号口令或手机验证码等）。因凭证保管不善导致的未授权使用，由您自行承担责任，法律法规另有规定的除外。',
        '禁止将账号出借、转让或用于违法违规用途。我们发现存在明显异常或违规时，可限制、冻结或终止相关账号的访问。',
      ],
    },
    {
      heading: '四、使用规范',
      paragraphs: [
        '您不得利用本产品从事危害网络安全、侵犯他人合法权益、传播违法信息或干扰系统正常运行的行为，包括但不限于未授权扫描、恶意流量冲击、绕过访问控制等。',
        '会议内容由参会各方自行负责。请遵守所在单位制度与适用法律法规，勿在会议中泄露国家秘密、商业秘密或他人隐私。',
      ],
    },
    {
      heading: '五、录制与资料',
      paragraphs: [
        '在您或会议主持人开启录制、导出或下载相关材料时，相关文件可能保存在您授权的浏览器本机目录、或由协作媒体平台归档的位置。请在开启前告知参会者并取得必要同意。',
        '您应合法使用录制与回放材料，不得擅自对外传播涉及他人肖像、语音或敏感信息的内容。',
      ],
    },
    {
      heading: '六、可用性说明',
      paragraphs: [
        '受公网质量、卫星链路、浏览器能力及协作媒体平台状态影响，音视频可能出现延迟、卡顿或短暂中断。我们将在合理范围内维护稳定运行，但不对特定链路条件下的实时性作绝对保证。',
        '我们可能进行维护、升级或应急处置，并尽量通过页面提示等方式提前或及时告知。',
      ],
    },
    {
      heading: '七、知识产权',
      paragraphs: [
        '本产品的页面设计、文案、标识及相关软件权利归权利人所有。未经许可，您不得复制、篡改或以其他方式侵害相关权利。',
        '您在使用过程中上传或产生的合法内容，其权利归属依法律及您与所属单位的约定确定；您授予我们为提供本产品所必需的、有限的处理权限。',
      ],
    },
    {
      heading: '八、免责与责任限制',
      paragraphs: [
        '因不可抗力、基础电信故障、外部平台中断、您的设备或浏览器配置不当等非我们可控原因导致的损失，我们在法律允许范围内免责。',
        '在法律允许的最大范围内，我们对因使用或无法使用本产品而产生的间接、附带或后果性损失不承担责任。',
      ],
    },
    {
      heading: '九、协议变更与终止',
      paragraphs: [
        '我们可能根据业务或法规要求更新本协议，并在页面公示更新后的文本。继续使用即视为接受更新后的协议。',
        '您可随时停止使用。我们也可在您严重违反本协议时终止向您提供访问。',
      ],
    },
    {
      heading: '十、联系我们',
      paragraphs: [
        '如对本协议有疑问，请通过本产品「关于」页面或所属单位信息化渠道联系卫星应用创新研究院相关支持人员。',
      ],
    },
  ],
}

const PRIVACY_ZH: LegalDoc = {
  id: 'privacy',
  title: '卫通会议隐私政策',
  updatedAt: '2026-11-20',
  sections: [
    {
      heading: '一、引言',
      paragraphs: [
        '卫星应用创新研究院（以下简称「我们」）重视您的个人信息保护。本政策说明卫通会议网页端如何收集、使用、存储与保护与您相关的信息。',
        '本产品运行于浏览器中。除本政策说明外，浏览器、操作系统及您所在网络环境还可能按其自身规则处理数据，请同时关注其隐私说明。',
      ],
    },
    {
      heading: '二、我们收集的信息',
      paragraphs: [
        '账号信息：登录名、显示名、手机号（若使用验证码登录）、头像等您主动填写或上传的资料。',
        '会议与会务信息：会议主题、时间、参会关系、聊天消息、会控操作记录等，用于提供会务与协同功能。',
        '设备与媒体权限：在您授权后，浏览器可访问摄像头、麦克风与扬声器，用于音视频采集与播放；设备列表与偏好可保存在本产品设置中。',
        '网络与日志：为保障运行与排查故障，可能记录访问时间、大致网络质量探测结果、错误日志等运维所需信息。',
        '浏览器本地数据：登录令牌、主题偏好、部分录制索引等可能保存在浏览器本地或您授权的本机目录中。',
      ],
    },
    {
      heading: '三、我们如何使用信息',
      paragraphs: [
        '用于身份核验、会议发起与加入、音视频通信、录制回放、安全风控与体验改进。',
        '在实现功能所必需的范围内，可能与经授权的协作媒体平台交换会控与媒体会话所需的技术参数；我们要求相关方仅在履约范围内处理。',
        '未经您同意，不会将个人信息用于与本产品无关的营销推送。',
      ],
    },
    {
      heading: '四、浏览器本地数据',
      paragraphs: [
        '本产品使用浏览器本地能力保存登录状态、界面主题等，以便您再次打开页面时保持体验连续。',
        '您可以通过浏览器设置清除站点数据；清除后可能需要重新登录，部分本机偏好也会丢失。',
      ],
    },
    {
      heading: '五、共享、转让与公开',
      paragraphs: [
        '我们不会出售您的个人信息。仅在下列情形下共享：获得您的同意；为完成会议所必需的协作媒体处理；法律法规或有权机关依法提出的要求；合并、重组等情形下在合法前提下的转移并继续受本政策约束。',
      ],
    },
    {
      heading: '六、存储与安全',
      paragraphs: [
        '我们采取合理的技术与管理措施保护数据，例如传输加密、访问控制与最小权限。',
        '信息保存期限为实现本政策所述目的所必需的最短时间，或法律法规要求的期限。逾期将删除或匿名化处理，法律另有规定的除外。',
      ],
    },
    {
      heading: '七、您的权利',
      paragraphs: [
        '在适用法律范围内，您有权查询、更正、删除您的部分个人信息，或撤回非必需的授权（例如关闭摄像头权限）。部分操作可在设置页或浏览器权限面板完成；涉及账号注销等请联系管理员。',
        '请注意：撤回媒体权限后，音视频相关功能将无法正常使用。',
      ],
    },
    {
      heading: '八、未成年人',
      paragraphs: [
        '本产品主要面向单位协同场景。如您为未成年人，请在监护人指导下阅读本政策并使用。',
      ],
    },
    {
      heading: '九、政策更新',
      paragraphs: [
        '我们可能适时更新本政策，并在页面公布。重大变更时，我们将以更显著方式提示。',
      ],
    },
    {
      heading: '十、联系我们',
      paragraphs: [
        '如对本政策或个人信息处理有疑问、投诉或建议，请通过本产品「关于」页面或所属单位信息化渠道联系卫星应用创新研究院。',
      ],
    },
  ],
}

const TERMS_EN: LegalDoc = {
  id: 'terms',
  title: 'Weitong Meeting Terms of Use',
  updatedAt: '2026-11-20',
  sections: [
    {
      heading: '1. Scope',
      paragraphs: [
        'These Terms are an agreement between you and the provider of Weitong Meeting (“we”, “us”) regarding your access to and use of the Weitong Meeting web application (the “Product”) through a browser.',
        'By opening the Product, registering or signing in, starting or joining a meeting, or using recording and playback, you confirm that you have read and agree to these Terms. If you do not agree, please stop using the Product.',
      ],
    },
    {
      heading: '2. Product Description',
      paragraphs: [
        'The Product provides browser-based video meeting and meeting-management capabilities for ship-to-shore and cross-site collaboration. Media transport, transcoding, and some meeting-control functions may be carried by an authorized collaboration media platform; page orchestration, account sessions, and business data are provided by this Product’s control plane.',
        'The Product is delivered as web pages. You may access it with a common browser. Available features follow what is actually enabled on the page and may change with releases.',
      ],
    },
    {
      heading: '3. Accounts and Security',
      paragraphs: [
        'You must keep your sign-in credentials (password or SMS code) secure. Unauthorized use caused by poor credential handling is your responsibility, except where laws provide otherwise.',
        'Accounts may not be lent, transferred, or used for unlawful purposes. We may restrict, freeze, or terminate access when clear abuse or violations are found.',
      ],
    },
    {
      heading: '4. Acceptable Use',
      paragraphs: [
        'You must not use the Product to harm network security, infringe others’ rights, spread unlawful content, or disrupt normal operation, including unauthorized scanning, malicious traffic, or bypassing access controls.',
        'Meeting content is the responsibility of participants. Follow your organization’s rules and applicable law. Do not disclose state secrets, trade secrets, or others’ private information in meetings.',
      ],
    },
    {
      heading: '5. Recording and Materials',
      paragraphs: [
        'When you or a host enable recording, export, or download, files may be stored in a browser-authorized local folder or archived by the collaboration media platform. Inform participants and obtain needed consent before enabling recording.',
        'Use recordings and playback materials lawfully. Do not redistribute content that includes others’ likeness, voice, or sensitive information without authorization.',
      ],
    },
    {
      heading: '6. Availability',
      paragraphs: [
        'Public network quality, satellite links, browser capability, and collaboration media platform status may cause delay, stutter, or brief interruption. We maintain reasonable stability but do not guarantee real-time performance under every link condition.',
        'We may perform maintenance, upgrades, or emergency actions and will try to notify you via on-page notices when practicable.',
      ],
    },
    {
      heading: '7. Intellectual Property',
      paragraphs: [
        'Page design, copy, marks, and related software rights belong to the rights holders. You may not copy, alter, or otherwise infringe those rights without permission.',
        'Rights in lawful content you upload or create follow law and your agreement with your organization. You grant us a limited right to process such content as needed to provide the Product.',
      ],
    },
    {
      heading: '8. Disclaimer and Limitation',
      paragraphs: [
        'To the extent permitted by law, we are not liable for losses caused by force majeure, telecom failures, outages of external platforms, or unsuitable device or browser configuration beyond our control.',
        'To the maximum extent permitted by law, we are not liable for indirect, incidental, or consequential losses arising from use of or inability to use the Product.',
      ],
    },
    {
      heading: '9. Changes and Termination',
      paragraphs: [
        'We may update these Terms for business or legal reasons and publish the updated text on the page. Continued use means you accept the updated Terms.',
        'You may stop using the Product at any time. We may also terminate access if you seriously breach these Terms.',
      ],
    },
    {
      heading: '10. Contact',
      paragraphs: [
        'Questions about these Terms may be directed to Satellite Application Innovation Research Institute support via the Product’s About page or your organization’s IT channel.',
      ],
    },
  ],
}

const PRIVACY_EN: LegalDoc = {
  id: 'privacy',
  title: 'Weitong Meeting Privacy Policy',
  updatedAt: '2026-11-20',
  sections: [
    {
      heading: '1. Introduction',
      paragraphs: [
        'Satellite Application Innovation Research Institute (“we”, “us”) values protection of your personal information. This Policy explains how the Weitong Meeting web app collects, uses, stores, and protects information related to you.',
        'The Product runs in a browser. Besides this Policy, your browser, operating system, and network environment may process data under their own rules; please also review their privacy notices.',
      ],
    },
    {
      heading: '2. Information We Collect',
      paragraphs: [
        'Account information: login name, display name, mobile number (if SMS sign-in is used), avatar, and other data you provide or upload.',
        'Meeting information: titles, times, participation relationships, chat messages, and meeting-control records needed for collaboration.',
        'Device and media permissions: after you grant access, the browser may use camera, microphone, and speakers for capture and playback; device lists and preferences may be saved in Product settings.',
        'Network and logs: access time, approximate network-quality probes, and error logs may be kept for operations and troubleshooting.',
        'Browser local data: sign-in tokens, theme preference, and some recording indexes may be stored locally in the browser or in a folder you authorize.',
      ],
    },
    {
      heading: '3. How We Use Information',
      paragraphs: [
        'For identity checks, starting and joining meetings, audio/video communication, recording playback, security controls, and experience improvement.',
        'Within what is necessary to provide features, we may exchange technical parameters for meeting control and media sessions with an authorized collaboration media platform; such parties must process data only for that purpose.',
        'We will not use personal information for unrelated marketing without your consent.',
      ],
    },
    {
      heading: '4. Browser Local Data',
      paragraphs: [
        'The Product uses browser storage for sign-in state and UI theme so your experience continues when you reopen the page.',
        'You may clear site data in browser settings; you may need to sign in again, and some local preferences may be lost.',
      ],
    },
    {
      heading: '5. Sharing, Transfer, and Disclosure',
      paragraphs: [
        'We do not sell your personal information. Sharing occurs only with your consent; when needed for collaboration media processing of a meeting; when required by law or competent authorities; or in lawful transfers during merger or reorganization that remain subject to this Policy.',
      ],
    },
    {
      heading: '6. Retention and Security',
      paragraphs: [
        'We apply reasonable technical and organizational measures such as transport encryption, access control, and least privilege.',
        'We retain information only as long as needed for the purposes in this Policy or as required by law, then delete or anonymize it unless law requires otherwise.',
      ],
    },
    {
      heading: '7. Your Rights',
      paragraphs: [
        'Where applicable law allows, you may request access to, correction, or deletion of some personal information, or withdraw non-essential authorizations (for example camera permission). Some actions are available in settings or browser permission panels; account closure requests go to an administrator.',
        'Note: after media permissions are withdrawn, related audio/video features will not work normally.',
      ],
    },
    {
      heading: '8. Minors',
      paragraphs: [
        'The Product is mainly for organizational collaboration. If you are a minor, please read this Policy and use the Product under a guardian’s guidance.',
      ],
    },
    {
      heading: '9. Policy Updates',
      paragraphs: [
        'We may update this Policy and publish changes on the page. For material changes we will provide a more prominent notice.',
      ],
    },
    {
      heading: '10. Contact',
      paragraphs: [
        'For questions, complaints, or suggestions about this Policy or personal information processing, contact Satellite Application Innovation Research Institute via the Product’s About page or your organization’s IT channel.',
      ],
    },
  ],
}

export const LEGAL_DOCS: Record<LegalLocale, Record<LegalDocId, LegalDoc>> = {
  zh: { terms: TERMS_ZH, privacy: PRIVACY_ZH },
  en: { terms: TERMS_EN, privacy: PRIVACY_EN },
}

export function getLegalDoc(id: LegalDocId, locale: LegalLocale = 'zh'): LegalDoc {
  return LEGAL_DOCS[locale][id]
}
