/**
 * 会议同传控制台 · 时间账核心逻辑
 *
 * 一条时间账串起三类事实：
 *  1. 发言队列：每段发言开始时快照归属译员（Assignment）；
 *  2. 译员交接：确认前字幕仍归原译员，确认后版本链转到接手人；
 *  3. 字幕版本：先到生效、后到冲突（发冲突编号+当前版本），
 *     发言段结束/跳过时未确认译文立即失效并按新发言人重算，失败可重试。
 *
 * 所有函数都是纯领域逻辑：直接修改传入的 state（Qwik store 兼容），
 * 需要房间隔离的地方一律以 roomId 为准，切换会议厅互不影响。
 */

export type SpeechStatus = 'queued' | 'speaking' | 'done' | 'skipped';
export type ChannelStatus = 'active' | 'handoff' | 'standby';
export type CaptionState = 'pending' | 'confirmed' | 'invalidated';
export type RecalcStatus = 'pending' | 'done' | 'failed';
export type LedgerKind =
  | 'queue'
  | 'segment-start'
  | 'segment-end'
  | 'handoff-request'
  | 'handoff-confirm'
  | 'handoff-cancel'
  | 'caption-accepted'
  | 'caption-confirmed'
  | 'caption-conflict'
  | 'caption-invalidated'
  | 'recalc-success'
  | 'recalc-failed'
  | 'room-switch'
  | 'low-latency';

export interface Room {
  id: string;
  name: string;
  topic: string;
  simultaneousChannels: number;
}

export interface Speech {
  id: string;
  roomId: string;
  speaker: string;
  delegation: string;
  language: string;
  topic: string;
  plannedSeconds: number;
  remainingSeconds: number;
  status: SpeechStatus;
  updatedAt: string;
}

export interface Channel {
  id: string;
  roomId: string;
  language: string;
  interpreter: string;
  status: ChannelStatus;
  health: number;
}

export interface Term {
  id: string;
  phrase: string;
  translation: string;
  language: string;
  approved: boolean;
}

/** 发言段开始时定下的归属译员快照 */
export interface Assignment {
  id: string;
  roomId: string;
  speechId: string;
  channelId: string;
  language: string;
  interpreter: string;
  at: string;
}

/** 译员交接：confirmedAt 为空表示待确认，确认前字幕仍归原译员 */
export interface Handoff {
  id: string;
  roomId: string;
  channelId: string;
  language: string;
  fromInterpreter: string;
  toInterpreter: string;
  requestedAt: string;
  confirmedAt: string | null;
}

/** 字幕版本：interpreter 为归属译员，submittedBy 为实际提交人 */
export interface CaptionVersion {
  id: string;
  roomId: string;
  speechId: string;
  language: string;
  interpreter: string;
  submittedBy: string;
  text: string;
  revision: number;
  state: CaptionState;
  at: string;
  recalculatedFrom?: string;
}

/** 后到提交的冲突记录：冲突编号 + 当时生效的当前版本 */
export interface CaptionConflict {
  id: string;
  conflictNo: number;
  roomId: string;
  speechId: string;
  language: string;
  submittedBy: string;
  ownerInterpreter: string | null;
  currentRevision: number | null;
  attemptedText: string;
  at: string;
}

/** 未确认译文按新发言人重算的任务，失败保留原版本可重试 */
export interface RecalcTask {
  id: string;
  roomId: string;
  captionId: string;
  fromSpeechId: string;
  language: string;
  status: RecalcStatus;
  attempts: number;
  lastError: string | null;
  at: string;
}

export interface LedgerEntry {
  id: string;
  seq: number;
  at: string;
  roomId: string;
  kind: LedgerKind;
  message: string;
}

export interface ConferenceState {
  rooms: Room[];
  activeRoomId: string;
  speechQueue: Speech[];
  channels: Channel[];
  terms: Term[];
  assignments: Assignment[];
  handoffs: Handoff[];
  captions: CaptionVersion[];
  conflicts: CaptionConflict[];
  recalcTasks: RecalcTask[];
  ledger: LedgerEntry[];
  /** 每个会议厅独立的冲突编号序列 */
  conflictSeq: Record<string, number>;
  ledgerSeq: number;
  lowLatency: boolean;
}

const uid = () => crypto.randomUUID();
const ts = () => new Date().toISOString();

/** 时间账记账：全局递增序号，按会议厅归账 */
export function log(state: ConferenceState, roomId: string, kind: LedgerKind, message: string) {
  state.ledgerSeq += 1;
  state.ledger.unshift({ id: uid(), seq: state.ledgerSeq, at: ts(), roomId, kind, message });
}

export function roomOf(state: ConferenceState, roomId: string) {
  return state.rooms.find((room) => room.id === roomId) ?? state.rooms[0];
}

export function currentSpeech(state: ConferenceState, roomId: string) {
  return state.speechQueue.find((item) => item.roomId === roomId && item.status === 'speaking');
}

export function pendingHandoff(state: ConferenceState, channelId: string) {
  return state.handoffs.find((item) => item.channelId === channelId && item.confirmedAt === null);
}

/** 某发言段某语种当前生效的版本链头（最新一条未失效版本） */
export function chainHead(state: ConferenceState, speechId: string, language: string) {
  return state.captions
    .filter((item) => item.speechId === speechId && item.language === language && item.state !== 'invalidated')
    .sort((a, b) => b.revision - a.revision)[0];
}

/** 发言段开始时的归属译员快照 */
export function assignmentsOf(state: ConferenceState, speechId: string) {
  return state.assignments.filter((item) => item.speechId === speechId);
}

// ---------------------------------------------------------------------------
// 发言队列
// ---------------------------------------------------------------------------

/** 开始一段发言：结束当前段 → 定归属译员 → 重试上一段遗留的重算 */
export function startSpeech(state: ConferenceState, roomId: string, speechId: string) {
  const speech = state.speechQueue.find((item) => item.id === speechId && item.roomId === roomId);
  if (!speech || speech.status !== 'queued') return;
  const current = currentSpeech(state, roomId);
  if (current) endSpeech(state, current.id, 'done', true);
  speech.status = 'speaking';
  speech.updatedAt = ts();
  const channels = state.channels.filter((item) => item.roomId === roomId && item.status !== 'standby');
  for (const channel of channels) {
    state.assignments.push({
      id: uid(),
      roomId,
      speechId: speech.id,
      channelId: channel.id,
      language: channel.language,
      interpreter: channel.interpreter,
      at: ts()
    });
  }
  log(
    state,
    roomId,
    'segment-start',
    `${speech.speaker}（${speech.delegation}）开始发言，归属译员：${channels.map((item) => `${item.language}·${item.interpreter}`).join('、') || '无频道'}`
  );
  // 新发言段就绪，上一段未确认译文的重算此刻按新发言人重试
  retryRecalcs(state, roomId);
  if (state.lowLatency) pruneForLowLatency(state, roomId);
}

/**
 * 结束或跳过一段发言：未确认译文立即失效并按新发言人重算。
 * deferRecalc 用于“紧接着开新段”的场景，等新段归属定下来再统一重算。
 */
export function endSpeech(state: ConferenceState, speechId: string, status: 'done' | 'skipped', deferRecalc = false) {
  const speech = state.speechQueue.find((item) => item.id === speechId);
  if (!speech || speech.status !== 'speaking') return;
  speech.status = status;
  speech.updatedAt = ts();
  log(state, speech.roomId, 'segment-end', `${speech.speaker} ${status === 'done' ? '发言结束' : '被跳过'}，未确认译文立即失效`);
  const pendings = state.captions.filter((item) => item.speechId === speech.id && item.state === 'pending');
  for (const caption of pendings) {
    caption.state = 'invalidated';
    log(state, speech.roomId, 'caption-invalidated', `${caption.language} 字幕 v${caption.revision}（${caption.interpreter}）随发言段结束失效`);
    const task: RecalcTask = {
      id: uid(),
      roomId: speech.roomId,
      captionId: caption.id,
      fromSpeechId: speech.id,
      language: caption.language,
      status: 'pending',
      attempts: 0,
      lastError: null,
      at: ts()
    };
    state.recalcTasks.push(task);
    if (!deferRecalc) attemptRecalc(state, task);
  }
  if (state.lowLatency) pruneForLowLatency(state, speech.roomId);
}

/** 加入发言队列 */
export function enqueueSpeech(state: ConferenceState, values: { speaker: string; delegation: string; language: string; topic: string; plannedSeconds: number }) {
  state.speechQueue.push({
    id: uid(),
    roomId: state.activeRoomId,
    ...values,
    remainingSeconds: values.plannedSeconds,
    status: 'queued',
    updatedAt: ts()
  });
  log(state, state.activeRoomId, 'queue', `${values.speaker}（${values.delegation}）已加入发言队列`);
}

/** 跳过尚未开始的发言：无字幕产生，只记账 */
export function skipQueued(state: ConferenceState, speechId: string) {
  const speech = state.speechQueue.find((item) => item.id === speechId);
  if (!speech || speech.status !== 'queued') return;
  speech.status = 'skipped';
  speech.updatedAt = ts();
  log(state, speech.roomId, 'queue', `${speech.speaker} 的发言在排队中被跳过`);
}

/** 跳到下一段：当前发言按跳过处理，队首开始发言 */
export function skipToNext(state: ConferenceState, roomId: string) {
  const current = currentSpeech(state, roomId);
  const next = state.speechQueue.find((item) => item.roomId === roomId && item.status === 'queued');
  if (current) endSpeech(state, current.id, 'skipped', true);
  if (next) startSpeech(state, roomId, next.id);
  else if (current) retryRecalcs(state, roomId);
}

// ---------------------------------------------------------------------------
// 译员交接
// ---------------------------------------------------------------------------

/** 发起交接：确认前字幕仍归原译员 */
export function requestHandoff(state: ConferenceState, channelId: string, toInterpreter: string) {
  const channel = state.channels.find((item) => item.id === channelId);
  const name = toInterpreter.trim();
  if (!channel || !name || name === channel.interpreter || pendingHandoff(state, channelId)) return;
  state.handoffs.unshift({
    id: uid(),
    roomId: channel.roomId,
    channelId,
    language: channel.language,
    fromInterpreter: channel.interpreter,
    toInterpreter: name,
    requestedAt: ts(),
    confirmedAt: null
  });
  channel.status = 'handoff';
  log(state, channel.roomId, 'handoff-request', `${channel.language} 频道交接 ${channel.interpreter} → ${name}，确认前字幕仍归属 ${channel.interpreter}`);
}

/** 确认交接：此后字幕归接手人，此前版本保持原归属不改写 */
export function confirmHandoff(state: ConferenceState, channelId: string) {
  const channel = state.channels.find((item) => item.id === channelId);
  const handoff = pendingHandoff(state, channelId);
  if (!channel || !handoff) return;
  handoff.confirmedAt = ts();
  channel.interpreter = handoff.toInterpreter;
  channel.status = 'active';
  channel.health = Math.min(100, channel.health + 2);
  log(
    state,
    channel.roomId,
    'handoff-confirm',
    `${handoff.toInterpreter} 确认接续 ${channel.language} 频道，此后字幕归属 ${handoff.toInterpreter}，已提交的版本仍属 ${handoff.fromInterpreter}`
  );
}

export function cancelHandoff(state: ConferenceState, channelId: string) {
  const channel = state.channels.find((item) => item.id === channelId);
  const handoff = pendingHandoff(state, channelId);
  if (!channel || !handoff) return;
  state.handoffs = state.handoffs.filter((item) => item.id !== handoff.id);
  channel.status = 'active';
  log(state, channel.roomId, 'handoff-cancel', `${channel.language} 频道交接取消，仍由 ${channel.interpreter} 值守`);
}

// ---------------------------------------------------------------------------
// 字幕版本
// ---------------------------------------------------------------------------

export type SubmitResult =
  | { ok: true; revision: number; interpreter: string; transferred: boolean }
  | { ok: false; kind: 'rejected'; reason: string }
  | { ok: false; kind: 'conflict'; conflictNo: number; currentRevision: number | null; currentInterpreter: string | null };

/**
 * 提交字幕：只受理本厅正在发言的段。
 * 先到生效；后到的其他译员拿到冲突编号和当前版本。
 * 交接确认前提交的一律归原译员；确认后版本链转到接手人。
 */
export function submitCaption(
  state: ConferenceState,
  args: { roomId: string; language: string; submittedBy: string; text: string }
): SubmitResult {
  const speech = currentSpeech(state, args.roomId);
  const submittedBy = args.submittedBy.trim();
  const text = args.text.trim();
  if (!speech) return { ok: false, kind: 'rejected', reason: '当前没有发言中的代表，字幕不受理' };
  if (!submittedBy || !text) return { ok: false, kind: 'rejected', reason: '提交人与字幕内容不能为空' };
  const channel = state.channels.find((item) => item.roomId === args.roomId && item.language === args.language);
  if (!channel) return { ok: false, kind: 'rejected', reason: `本厅没有${args.language}频道` };

  const handoff = pendingHandoff(state, channel.id);
  // 有权提交人：在册译员 + 待确认的接手人
  const authorized = handoff ? [channel.interpreter, handoff.toInterpreter] : [channel.interpreter];
  const head = chainHead(state, speech.id, args.language);

  const accept = (transferred: boolean): SubmitResult => {
    const revision = (head?.revision ?? 0) + 1;
    state.captions.unshift({
      id: uid(),
      roomId: args.roomId,
      speechId: speech.id,
      language: args.language,
      interpreter: channel.interpreter,
      submittedBy,
      text,
      revision,
      state: 'pending',
      at: ts()
    });
    log(
      state,
      args.roomId,
      'caption-accepted',
      `${args.language} 字幕 v${revision} 生效，归属 ${channel.interpreter}` +
        (submittedBy !== channel.interpreter ? `（${submittedBy} 提交）` : '') +
        (transferred ? '，交接确认后版本链转至接手人' : '')
    );
    return { ok: true, revision, interpreter: channel.interpreter, transferred };
  };

  const conflict = (): SubmitResult => {
    state.conflictSeq[args.roomId] = (state.conflictSeq[args.roomId] ?? 0) + 1;
    const conflictNo = state.conflictSeq[args.roomId];
    state.conflicts.unshift({
      id: uid(),
      conflictNo,
      roomId: args.roomId,
      speechId: speech.id,
      language: args.language,
      submittedBy,
      ownerInterpreter: head?.interpreter ?? null,
      currentRevision: head?.revision ?? null,
      attemptedText: text,
      at: ts()
    });
    log(
      state,
      args.roomId,
      'caption-conflict',
      `${submittedBy} 提交 ${args.language} 字幕晚到冲突，编号 C-${conflictNo}，当前版本 ${head ? `v${head.revision}（${head.interpreter}）` : '暂无'}`
    );
    return { ok: false, kind: 'conflict', conflictNo, currentRevision: head?.revision ?? null, currentInterpreter: head?.interpreter ?? null };
  };

  if (!authorized.includes(submittedBy)) return conflict();
  if (!head) return accept(false); // 先到先生效
  if (head.submittedBy === submittedBy) return accept(false); // 同一人修订
  // 交接确认后，接手人接管版本链（确认时间晚于链上最新版本）
  const transferred =
    submittedBy === channel.interpreter &&
    state.handoffs.some((item) => item.channelId === channel.id && item.confirmedAt !== null && item.confirmedAt >= head.at);
  if (transferred) return accept(true);
  return conflict();
}

/** 审校确认：确认后的译文不随发言段结束失效 */
export function confirmCaption(state: ConferenceState, captionId: string) {
  const caption = state.captions.find((item) => item.id === captionId);
  if (!caption || caption.state !== 'pending') return;
  caption.state = 'confirmed';
  log(state, caption.roomId, 'caption-confirmed', `${caption.language} 字幕 v${caption.revision}（${caption.interpreter}）已确认，不再随段末失效`);
}

// ---------------------------------------------------------------------------
// 未确认译文重算
// ---------------------------------------------------------------------------

/** 按新发言人重算一条失效译文：成功则在新段重建待确认版本，失败保留原版本可重试 */
export function attemptRecalc(state: ConferenceState, task: RecalcTask): boolean {
  if (task.status === 'done') return true;
  task.attempts += 1;
  task.at = ts();
  const caption = state.captions.find((item) => item.id === task.captionId);
  const target = currentSpeech(state, task.roomId);
  const fail = (reason: string): false => {
    task.status = 'failed';
    task.lastError = reason;
    log(state, task.roomId, 'recalc-failed', `${task.language} 未确认译文重算失败（${reason}），原版本 v${caption?.revision ?? '?'} 已保留，可重试`);
    return false;
  };
  if (!caption) return fail('原版本缺失');
  if (!target || target.id === task.fromSpeechId) return fail('新发言段尚未开始');
  const assignment = assignmentsOf(state, target.id).filter((item) => item.language === task.language).at(-1);
  if (!assignment) return fail(`新发言段缺少${task.language}频道归属`);
  state.captions.unshift({
    id: uid(),
    roomId: task.roomId,
    speechId: target.id,
    language: task.language,
    interpreter: assignment.interpreter,
    submittedBy: assignment.interpreter,
    text: caption.text,
    revision: 1,
    state: 'pending',
    at: ts(),
    recalculatedFrom: caption.id
  });
  task.status = 'done';
  task.lastError = null;
  log(state, task.roomId, 'recalc-success', `${task.language} 未确认译文已按 ${target.speaker} 重算，归属 ${assignment.interpreter}，待确认`);
  return true;
}

/** 重试本厅所有未完成的重算（新段开始时自动调用，也可手动触发） */
export function retryRecalcs(state: ConferenceState, roomId: string) {
  for (const task of state.recalcTasks.filter((item) => item.roomId === roomId && item.status !== 'done')) {
    attemptRecalc(state, task);
  }
}

// ---------------------------------------------------------------------------
// 低延迟模式与会议厅切换
// ---------------------------------------------------------------------------

/** 低延迟模式：只保留本厅正在发言那段的关键状态，其他会议厅不动 */
export function pruneForLowLatency(state: ConferenceState, roomId: string) {
  log(state, roomId, 'low-latency', '低延迟模式：仅保留当前发言段的关键状态');
  const current = currentSpeech(state, roomId);
  const keepSpeechId = current?.id ?? null;
  const openCaptionIds = new Set(
    state.recalcTasks.filter((item) => item.roomId === roomId && item.status !== 'done').map((item) => item.captionId)
  );
  state.captions = state.captions.filter(
    (item) => item.roomId !== roomId || item.speechId === keepSpeechId || openCaptionIds.has(item.id)
  );
  state.conflicts = state.conflicts.filter((item) => item.roomId !== roomId || item.speechId === keepSpeechId);
  state.assignments = state.assignments.filter((item) => item.roomId !== roomId || item.speechId === keepSpeechId);
  state.recalcTasks = state.recalcTasks.filter((item) => item.roomId !== roomId || item.status !== 'done');
  state.handoffs = state.handoffs.filter((item) => item.roomId !== roomId || item.confirmedAt === null);
  const roomEntries = state.ledger.filter((item) => item.roomId === roomId).slice(0, 8);
  const otherEntries = state.ledger.filter((item) => item.roomId !== roomId);
  state.ledger = [...otherEntries, ...roomEntries].sort((a, b) => b.seq - a.seq);
}

/** 切换会议厅：只改视角并在目标厅记一笔，其他厅状态不动 */
export function switchRoom(state: ConferenceState, roomId: string) {
  if (state.activeRoomId === roomId) return;
  state.activeRoomId = roomId;
  log(state, roomId, 'room-switch', `切换到 ${roomOf(state, roomId).name}，其他会议厅状态不受影响`);
}

// ---------------------------------------------------------------------------
// 初始数据与持久化
// ---------------------------------------------------------------------------

export const STORAGE_KEY = 'conference-interpretation-v2';

export function seedState(): ConferenceState {
  const now = ts();
  return {
    rooms: [
      { id: 'hall-a', name: 'A厅 · 全体会议', topic: '全球气候融资', simultaneousChannels: 6 },
      { id: 'hall-b', name: 'B厅 · 技术分会', topic: '人工智能基础设施', simultaneousChannels: 4 }
    ],
    activeRoomId: 'hall-a',
    speechQueue: [
      { id: 'speech-1', roomId: 'hall-a', speaker: 'Amina Diallo', delegation: '塞内加尔', language: '英语', topic: '适应性融资缺口', plannedSeconds: 600, remainingSeconds: 214, status: 'speaking', updatedAt: now },
      { id: 'speech-2', roomId: 'hall-a', speaker: '李明远', delegation: '中国', language: '中文', topic: '绿色基础设施机制', plannedSeconds: 600, remainingSeconds: 600, status: 'queued', updatedAt: now },
      { id: 'speech-3', roomId: 'hall-b', speaker: 'Maria Silva', delegation: '巴西', language: '葡萄牙语', topic: '边缘算力与能源', plannedSeconds: 420, remainingSeconds: 420, status: 'queued', updatedAt: now }
    ],
    channels: [
      { id: 'ch-a-zh', roomId: 'hall-a', language: '中文', interpreter: '周雨', status: 'active', health: 96 },
      { id: 'ch-a-es', roomId: 'hall-a', language: '西班牙语', interpreter: 'Lucía M.', status: 'active', health: 91 },
      { id: 'ch-a-fr', roomId: 'hall-a', language: '法语', interpreter: 'Noah B.', status: 'standby', health: 88 },
      { id: 'ch-b-zh', roomId: 'hall-b', language: '中文', interpreter: '何佳', status: 'active', health: 94 }
    ],
    terms: [
      { id: 'term-1', phrase: 'loss and damage', translation: '损失与损害', language: '中文', approved: true },
      { id: 'term-2', phrase: 'edge inference', translation: '边缘推理', language: '中文', approved: true },
      { id: 'term-3', phrase: 'just transition', translation: '公正转型', language: '中文', approved: false }
    ],
    assignments: [
      { id: 'assign-1', roomId: 'hall-a', speechId: 'speech-1', channelId: 'ch-a-zh', language: '中文', interpreter: '周雨', at: now },
      { id: 'assign-2', roomId: 'hall-a', speechId: 'speech-1', channelId: 'ch-a-es', language: '西班牙语', interpreter: 'Lucía M.', at: now }
    ],
    handoffs: [],
    captions: [
      { id: 'caption-1', roomId: 'hall-a', speechId: 'speech-1', language: '中文', interpreter: '周雨', submittedBy: '周雨', text: '我们需要把适应资金与可衡量的社区韧性目标绑定。', revision: 1, state: 'confirmed', at: now }
    ],
    conflicts: [],
    recalcTasks: [],
    ledger: [
      { id: 'ledger-3', seq: 3, at: now, roomId: 'hall-a', kind: 'caption-confirmed', message: '中文 字幕 v1（周雨）已确认，不再随段末失效' },
      { id: 'ledger-2', seq: 2, at: now, roomId: 'hall-a', kind: 'caption-accepted', message: '中文 字幕 v1 生效，归属 周雨' },
      { id: 'ledger-1', seq: 1, at: now, roomId: 'hall-a', kind: 'segment-start', message: 'Amina Diallo（塞内加尔）开始发言，归属译员：中文·周雨、西班牙语·Lucía M.' }
    ],
    conflictSeq: { 'hall-a': 0, 'hall-b': 0 },
    ledgerSeq: 3,
    lowLatency: false
  };
}

/** 读取本地持久化状态，缺字段时回落到种子结构，保证旧数据不炸 */
export function readState(storage: Pick<Storage, 'getItem'> | undefined): ConferenceState {
  const seed = seedState();
  if (!storage) return seed;
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return seed;
    const parsed = JSON.parse(raw) as Partial<ConferenceState>;
    return {
      ...seed,
      ...parsed,
      rooms: parsed.rooms ?? seed.rooms,
      speechQueue: parsed.speechQueue ?? seed.speechQueue,
      channels: parsed.channels ?? seed.channels,
      terms: parsed.terms ?? seed.terms,
      assignments: parsed.assignments ?? [],
      handoffs: parsed.handoffs ?? [],
      captions: parsed.captions ?? [],
      conflicts: parsed.conflicts ?? [],
      recalcTasks: parsed.recalcTasks ?? [],
      ledger: parsed.ledger ?? [],
      conflictSeq: parsed.conflictSeq ?? {},
      ledgerSeq: parsed.ledgerSeq ?? 0,
      lowLatency: parsed.lowLatency ?? false
    };
  } catch {
    return seed;
  }
}
