import { $, component$, useSignal, useStore, useTask$, useVisibleTask$ } from '@builder.io/qwik';
import { Progress } from '@qwik-ui/headless';
import { useForm, zodForm$ } from '@modular-forms/qwik';
import { useSpeakLocale } from 'qwik-speak';
import { z } from 'zod';
import type { DocumentHead } from '@builder.io/qwik-city';

type SpeechStatus = 'queued' | 'speaking' | 'done' | 'skipped';
type InterpreterStatus = 'active' | 'handoff' | 'standby';
type CaptionStatus = 'draft' | 'confirmed' | 'invalid' | 'superseded';
type LedgerKind = 'speech' | 'handoff' | 'caption' | 'conflict' | 'term' | 'room' | 'system';

type Room = { id: string; name: string; topic: string; simultaneousChannels: number };
type Speech = {
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
  /** 每段发言开始时定下的归属译员（按频道语言），交接不回溯改写 */
  ownerInterpreters: Record<string, string>;
};
type Channel = {
  id: string;
  roomId: string;
  language: string;
  interpreter: string;
  status: InterpreterStatus;
  health: number;
  /** 交接中的接手人，确认前字幕仍算原译员版本 */
  pendingInterpreter?: string;
};
type Term = { id: string; phrase: string; translation: string; language: string; approved: boolean };
type Caption = {
  id: string;
  speechId: string;
  roomId: string;
  language: string;
  interpreter: string;
  text: string;
  revision: number;
  at: string;
  status: CaptionStatus;
  /** 重算来源版本（按新发言人重算时记录） */
  recalculatedFrom?: string;
  /** 重算失败原因，保留原版本可重试 */
  recalcError?: string;
};
/** 冲突记录：先到版本生效，后到译员拿到冲突编号和当前版本 */
type Conflict = {
  id: string;
  at: string;
  roomId: string;
  speechId: string;
  language: string;
  winnerCaptionId: string;
  loserCaptionId: string;
  currentRevision: number;
  currentText: string;
};
type LedgerEvent = {
  id: string;
  at: string;
  roomId: string;
  kind: LedgerKind;
  refId?: string;
  message: string;
};

interface ConferenceState {
  rooms: Room[];
  activeRoomId: string;
  speechQueue: Speech[];
  channels: Channel[];
  terms: Term[];
  captions: Caption[];
  conflicts: Conflict[];
  ledger: LedgerEvent[];
  lowLatency: boolean;
  /** 低延迟模式进入前的完整状态备份，退出时恢复 */
  _backup?: Partial<ConferenceState>;
}

const now = new Date().toISOString();
const seed: ConferenceState = {
  rooms: [
    { id: 'hall-a', name: 'A厅 · 全体会议', topic: '全球气候融资', simultaneousChannels: 6 },
    { id: 'hall-b', name: 'B厅 · 技术分会', topic: '人工智能基础设施', simultaneousChannels: 4 }
  ],
  activeRoomId: 'hall-a',
  speechQueue: [
    { id: 'speech-1', roomId: 'hall-a', speaker: 'Amina Diallo', delegation: '塞内加尔', language: '英语', topic: '适应性融资缺口', plannedSeconds: 600, remainingSeconds: 214, status: 'speaking', updatedAt: now, ownerInterpreters: { 中文: '周雨', 西班牙语: 'Lucía M.', 法语: 'Noah B.' } },
    { id: 'speech-2', roomId: 'hall-a', speaker: '李明远', delegation: '中国', language: '中文', topic: '绿色基础设施机制', plannedSeconds: 600, remainingSeconds: 600, status: 'queued', updatedAt: now, ownerInterpreters: {} },
    { id: 'speech-3', roomId: 'hall-b', speaker: 'Maria Silva', delegation: '巴西', language: '葡萄牙语', topic: '边缘算力与能源', plannedSeconds: 420, remainingSeconds: 420, status: 'queued', updatedAt: now, ownerInterpreters: {} }
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
  captions: [
    { id: 'caption-1', speechId: 'speech-1', roomId: 'hall-a', language: '中文', interpreter: '周雨', text: '我们需要把适应资金与可衡量的社区韧性目标绑定。', revision: 2, at: now, status: 'confirmed' }
  ],
  conflicts: [],
  ledger: [
    { id: 'audit-1', at: now, roomId: 'hall-a', kind: 'speech', message: 'Amina Diallo 开始发言，归属译员已锁定：中文→周雨、西班牙语→Lucía M.、法语→Noah B.', refId: 'speech-1' },
    { id: 'audit-2', at: new Date(Date.now() - 90000).toISOString(), roomId: 'hall-a', kind: 'speech', message: '临时插话申请已插入队列第2位' }
  ],
  lowLatency: false
};

const queueSchema = z.object({
  speaker: z.string().min(2, '请输入发言人'),
  delegation: z.string().min(2, '请输入代表团'),
  language: z.string().min(2),
  topic: z.string().min(3, '请输入议题'),
  plannedSeconds: z.coerce.number().min(60).max(3600)
});
type QueueForm = z.infer<typeof queueSchema>;

const STORAGE_KEY = 'conference-interpretation-v2';

function readState(): ConferenceState {
  if (typeof localStorage === 'undefined') return seed;
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as ConferenceState | null;
    // 仅接受带时间账结构的状态，旧版本回退到种子
    if (parsed && Array.isArray(parsed.ledger) && Array.isArray(parsed.speechQueue)) return parsed;
    return seed;
  } catch { return seed; }
}

const uuid = () => crypto.randomUUID();
const nowIso = () => new Date().toISOString();

/** 向统一时间账追加一条事件 */
function appendLedger(state: ConferenceState, kind: LedgerKind, roomId: string, message: string, refId?: string) {
  state.ledger.unshift({ id: uuid(), at: nowIso(), roomId, kind, refId, message });
}

/** 发言开始时锁定归属译员：按该厅当前各频道译员快照 */
function snapshotOwners(state: ConferenceState, roomId: string): Record<string, string> {
  const owners: Record<string, string> = {};
  for (const ch of state.channels) {
    if (ch.roomId === roomId) owners[ch.language] = ch.interpreter;
  }
  return owners;
}

/** 低延迟模式：仅保留该厅正在发言段的关键状态，其他厅不受影响 */
function trimToKeyState(state: ConferenceState, roomId: string) {
  const speakingIds = new Set(
    state.speechQueue.filter((s) => s.roomId === roomId && s.status === 'speaking').map((s) => s.id)
  );
  state.speechQueue = state.speechQueue.filter((s) => s.roomId !== roomId || speakingIds.has(s.id));
  state.captions = state.captions.filter((c) => c.roomId !== roomId || speakingIds.has(c.speechId));
  state.conflicts = state.conflicts.filter((c) => c.roomId !== roomId || speakingIds.has(c.speechId));
  state.channels = state.channels.filter((c) => c.roomId !== roomId || c.status === 'active');
  const roomLedger = state.ledger.filter((l) => l.roomId === roomId).slice(0, 8);
  state.ledger = [...state.ledger.filter((l) => l.roomId !== roomId), ...roomLedger];
}

export default component$(() => {
  const locale = useSpeakLocale();
  const state = useStore<ConferenceState>(readState());

  // 当前字幕编辑所基于的版本号（乐观锁），提交后不自动刷新，模拟并发场景
  const captionBaseRevision = useSignal(0);
  const captionConflict = useSignal<Conflict | null>(null);
  const captionText = useSignal('');
  const captionInterpreter = useSignal('');
  const queueMode = useSignal<'normal' | 'interrupt'>('normal');

  const queueLoader = useSignal<QueueForm>({ speaker: '', delegation: '', language: '英语', topic: '', plannedSeconds: 300 });
  const [queueForm, { Form: QueueForm, Field: QueueField }] = useForm<QueueForm>({
    loader: queueLoader,
    validate: zodForm$(queueSchema)
  });

  const activeRoom = () => state.rooms.find((room) => room.id === state.activeRoomId) ?? state.rooms[0];
  const roomQueue = () => state.speechQueue.filter((item) => item.roomId === state.activeRoomId);
  const roomChannels = () => state.channels.filter((item) => item.roomId === state.activeRoomId);
  const currentSpeech = () => roomQueue().find((item) => item.status === 'speaking');
  const currentChannel = () => roomChannels().find((item) => item.language === '中文');
  const currentCaption = () => {
    const speech = currentSpeech();
    const channel = currentChannel();
    if (!speech || !channel) return undefined;
    return state.captions.find((c) => c.speechId === speech.id && c.language === channel.language && c.status !== 'superseded');
  };

  // 切换发言段时，重置字幕编辑基线到当前生效版本
  useTask$(({ track }) => {
    track(() => state.speechQueue);
    track(() => state.activeRoomId);
    track(() => state.channels);
    track(() => state.captions);
    const speech = state.speechQueue.find((item) => item.roomId === state.activeRoomId && item.status === 'speaking');
    if (!speech) {
      captionBaseRevision.value = 0;
      captionText.value = '';
      captionInterpreter.value = '';
      return;
    }
    const channel = state.channels.find((c) => c.roomId === speech.roomId && c.language === '中文');
    const existing = state.captions.find((c) => c.speechId === speech.id && c.language === channel?.language && c.status !== 'superseded');
    captionBaseRevision.value = existing?.revision ?? 0;
    captionText.value = existing?.text ?? '';
    captionInterpreter.value = channel?.interpreter ?? '';
  });

  useVisibleTask$(({ track }) => {
    track(() => state);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  });

  /** 发言开始/结束/跳过：开始时锁定归属译员，结束或跳过时未确认译文失效并重算 */
  const advanceSpeech$ = $((id: string, status: SpeechStatus) => {
    const speech = state.speechQueue.find((item) => item.id === id);
    if (!speech) return;
    speech.status = status;
    speech.updatedAt = nowIso();
    if (status === 'speaking') {
      speech.ownerInterpreters = snapshotOwners(state, speech.roomId);
      state.speechQueue.forEach((item) => {
        if (item.id !== id && item.roomId === speech.roomId && item.status === 'speaking') {
          item.status = 'done';
          item.updatedAt = nowIso();
        }
      });
      const owners = Object.entries(speech.ownerInterpreters).map(([lang, interp]) => `${lang}→${interp}`).join('、');
      appendLedger(state, 'speech', speech.roomId, `${speech.speaker} 开始发言，归属译员已锁定：${owners}`, id);
    } else if (status === 'done' || status === 'skipped') {
      appendLedger(state, 'speech', speech.roomId, `${speech.speaker} 发言${status === 'done' ? '结束' : '跳过'}`, id);
      invalidateAndRecalculate$(id);
    }
  });

  /** 跳到下一段：结束当前发言并立即开始下一段，触发未确认译文失效与重算 */
  const jumpToNext$ = $((speechId: string) => {
    const speech = state.speechQueue.find((item) => item.id === speechId);
    if (!speech) return;
    speech.status = 'done';
    speech.updatedAt = nowIso();
    appendLedger(state, 'speech', speech.roomId, `${speech.speaker} 发言结束（跳到下一段）`, speechId);
    invalidateAndRecalculate$(speechId);
    const next = state.speechQueue.find((item) => item.roomId === speech.roomId && item.status === 'queued');
    if (next) {
      next.status = 'speaking';
      next.updatedAt = nowIso();
      next.ownerInterpreters = snapshotOwners(state, speech.roomId);
      const owners = Object.entries(next.ownerInterpreters).map(([lang, interp]) => `${lang}→${interp}`).join('、');
      appendLedger(state, 'speech', speech.roomId, `${next.speaker} 开始发言，归属译员已锁定：${owners}`, next.id);
    }
  });

  /** 未确认译文立即失效，并按新发言人重算；失败则保留原版本可重试 */
  const invalidateAndRecalculate$ = $((speechId: string) => {
    const speech = state.speechQueue.find((item) => item.id === speechId);
    if (!speech) return;
    const drafts = state.captions.filter((c) => c.speechId === speechId && c.status === 'draft');
    if (drafts.length === 0) return;
    drafts.forEach((c) => { c.status = 'invalid'; });
    appendLedger(state, 'caption', speech.roomId, `${drafts.length} 条未确认译文已失效，等待按新发言人重算`, speechId);
    recalculateForNewSpeaker$(speechId);
  });

  /** 按新发言人重算失效译文：重算到新发言段并归属其译员；无新发言人或无频道则失败保留 */
  const recalculateForNewSpeaker$ = $((oldSpeechId: string) => {
    const old = state.speechQueue.find((item) => item.id === oldSpeechId);
    if (!old) return;
    const target =
      state.speechQueue.find((item) => item.roomId === old.roomId && item.status === 'speaking' && item.id !== oldSpeechId) ??
      state.speechQueue
        .filter((item) => item.roomId === old.roomId && item.status === 'queued')
        .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))[0];
    const invalids = state.captions.filter((c) => c.speechId === oldSpeechId && c.status === 'invalid');
    if (invalids.length === 0) return;
    if (!target) {
      invalids.forEach((c) => { c.recalcError = '新发言人尚未确定，无法重算'; });
      appendLedger(state, 'caption', old.roomId, `重算失败：新发言人尚未确定，保留原版本可重试`, oldSpeechId);
      return;
    }
    let okCount = 0;
    let failCount = 0;
    for (const c of invalids) {
      const owner =
        target.ownerInterpreters?.[c.language] ??
        state.channels.find((ch) => ch.roomId === old.roomId && ch.language === c.language)?.interpreter;
      if (!owner) {
        c.recalcError = `新发言人无 ${c.language} 频道归属译员`;
        failCount++;
        continue;
      }
      state.captions = state.captions.map((x) => (x.id === c.id ? { ...x, status: 'superseded' } : x));
      state.captions.unshift({
        id: uuid(),
        speechId: target.id,
        roomId: old.roomId,
        language: c.language,
        interpreter: owner,
        text: c.text,
        revision: c.revision + 1,
        at: nowIso(),
        status: 'draft',
        recalculatedFrom: c.id
      });
      okCount++;
    }
    appendLedger(
      state,
      'caption',
      old.roomId,
      `已按新发言人 ${target.speaker} 重算 ${okCount} 条译文${failCount ? `，${failCount} 条失败保留原版本` : ''}`,
      oldSpeechId
    );
  });

  /** 重算失败后保留原版本，可重试 */
  const retryRecalculation$ = $((captionId: string) => {
    const caption = state.captions.find((c) => c.id === captionId);
    if (!caption) return;
    caption.recalcError = undefined;
    recalculateForNewSpeaker$(caption.speechId);
  });

  /** 提交字幕：乐观锁，先到生效，后到拿冲突编号和当前版本 */
  const publishCaption$ = $((values: { text: string }) => {
    const speech = state.speechQueue.find((item) => item.roomId === state.activeRoomId && item.status === 'speaking');
    const channel = state.channels.find((item) => item.roomId === state.activeRoomId && item.language === '中文');
    if (!speech || !channel || !values.text.trim()) return;
    const existing = state.captions.find(
      (c) => c.speechId === speech.id && c.language === channel.language && c.status !== 'superseded'
    );
    const submitter = captionInterpreter.value || channel.interpreter;
    // 乐观锁：提交基于看到的版本号，若已被他人抢先提交则冲突
    if (existing && existing.revision > captionBaseRevision.value) {
      const conflictId = `CF-${uuid().slice(0, 8)}`;
      const conflict: Conflict = {
        id: conflictId,
        at: nowIso(),
        roomId: speech.roomId,
        speechId: speech.id,
        language: channel.language,
        winnerCaptionId: existing.id,
        loserCaptionId: uuid(),
        currentRevision: existing.revision,
        currentText: existing.text
      };
      state.conflicts.unshift(conflict);
      captionConflict.value = conflict;
      appendLedger(
        state,
        'conflict',
        speech.roomId,
        `冲突 ${conflictId}：${submitter} 提交基于 v${captionBaseRevision.value}，但当前已生效 v${existing.revision}（${existing.interpreter}）。先到版本生效，后到译员请查看当前版本`,
        speech.id
      );
      return;
    }
    // 提交生效
    if (existing) {
      state.captions = state.captions.map((c) =>
        c.id === existing.id ? { ...c, text: values.text, revision: c.revision + 1, interpreter: submitter, at: nowIso(), status: 'draft' } : c
      );
      appendLedger(state, 'caption', speech.roomId, `${submitter} 提交新版字幕 v${existing.revision + 1}（${channel.language}）`, speech.id);
    } else {
      state.captions.unshift({
        id: uuid(),
        speechId: speech.id,
        roomId: speech.roomId,
        language: channel.language,
        interpreter: submitter,
        text: values.text,
        revision: 1,
        at: nowIso(),
        status: 'draft'
      });
      appendLedger(state, 'caption', speech.roomId, `${submitter} 开始为发言 ${speech.speaker} 字幕 v1（${channel.language}）`, speech.id);
    }
    captionConflict.value = null;
  });

  /** 确认字幕版本 */
  const confirmCaption$ = $((captionId: string) => {
    const caption = state.captions.find((c) => c.id === captionId);
    if (!caption) return;
    caption.status = 'confirmed';
    appendLedger(state, 'caption', caption.roomId, `字幕 v${caption.revision}（${caption.interpreter}）已确认`, captionId);
  });

  /** 刷新编辑基线到当前生效版本 */
  const refreshBase$ = $(() => {
    const speech = state.speechQueue.find((item) => item.roomId === state.activeRoomId && item.status === 'speaking');
    const channel = state.channels.find((item) => item.roomId === state.activeRoomId && item.language === '中文');
    if (!speech || !channel) return;
    const existing = state.captions.find((c) => c.speechId === speech.id && c.language === channel.language && c.status !== 'superseded');
    captionBaseRevision.value = existing?.revision ?? 0;
  });

  /** 基于当前版本修改：载入当前生效文本与版本号 */
  const adoptCurrent$ = $(() => {
    const speech = state.speechQueue.find((item) => item.roomId === state.activeRoomId && item.status === 'speaking');
    const channel = state.channels.find((item) => item.roomId === state.activeRoomId && item.language === '中文');
    if (!speech || !channel) return;
    const existing = state.captions.find((c) => c.speechId === speech.id && c.language === channel.language && c.status !== 'superseded');
    if (existing) {
      captionText.value = existing.text;
      captionBaseRevision.value = existing.revision;
    }
  });

  /** 开始交接：记录接手人，交接确认前字幕仍算原译员版本 */
  const handoff$ = $((channelId: string) => {
    const channel = state.channels.find((ch) => ch.id === channelId);
    if (!channel) return;
    let successor = `替补译员-${channel.language}`;
    if (typeof prompt !== 'undefined') {
      successor = prompt(`请输入 ${channel.language} 频道接手译员姓名`, successor) ?? successor;
    }
    state.channels = state.channels.map((ch) =>
      ch.id === channelId ? { ...ch, status: 'handoff', pendingInterpreter: successor } : ch
    );
    appendLedger(
      state,
      'handoff',
      state.activeRoomId,
      `${channel.language} 频道启动译员交接：${channel.interpreter} → ${successor}，交接确认前字幕仍算原译员版本`,
      channelId
    );
  });

  /** 完成交接：后续字幕归属新译员 */
  const completeHandoff$ = $((channelId: string) => {
    const channel = state.channels.find((ch) => ch.id === channelId);
    if (!channel) return;
    const successor = channel.pendingInterpreter ?? `替补译员-${channel.language}`;
    state.channels = state.channels.map((ch) =>
      ch.id === channelId
        ? { ...ch, interpreter: successor, status: 'active', pendingInterpreter: undefined, health: Math.min(100, ch.health + 2) }
        : ch
    );
    appendLedger(state, 'handoff', state.activeRoomId, `${channel.language} 频道交接完成：${successor} 接续，后续字幕归属新译员`, channelId);
  });

  /** 低延迟模式：进入时备份并仅保留正在发言段关键状态，退出时恢复 */
  const toggleLowLatency$ = $(() => {
    if (!state.lowLatency) {
      state._backup = JSON.parse(
        JSON.stringify({
          rooms: state.rooms,
          speechQueue: state.speechQueue,
          channels: state.channels,
          terms: state.terms,
          captions: state.captions,
          conflicts: state.conflicts,
          ledger: state.ledger
        })
      );
      trimToKeyState(state, state.activeRoomId);
      state.lowLatency = true;
      appendLedger(state, 'system', state.activeRoomId, '进入低延迟模式：仅保留正在发言段的关键状态');
    } else {
      const backup = state._backup;
      if (backup) {
        state.rooms = backup.rooms ?? state.rooms;
        state.speechQueue = backup.speechQueue ?? state.speechQueue;
        state.channels = backup.channels ?? state.channels;
        state.terms = backup.terms ?? state.terms;
        state.captions = backup.captions ?? state.captions;
        state.conflicts = backup.conflicts ?? state.conflicts;
        state.ledger = backup.ledger ?? state.ledger;
        state._backup = undefined;
      }
      state.lowLatency = false;
      appendLedger(state, 'system', state.activeRoomId, '退出低延迟模式：已恢复完整状态');
    }
  });

  /** 切换会议厅：低延迟模式下仅修剪目标厅，厅间互不影响 */
  const selectRoom$ = $((roomId: string) => {
    state.activeRoomId = roomId;
    if (state.lowLatency) trimToKeyState(state, roomId);
    appendLedger(
      state,
      'room',
      roomId,
      `切换到 ${state.rooms.find((room) => room.id === roomId)?.name}${state.lowLatency ? '（低延迟：仅保留关键状态）' : ''}`
    );
  });

  const addSpeech$ = $((values: QueueForm) => {
    state.speechQueue.push({
      id: uuid(),
      roomId: state.activeRoomId,
      ...values,
      remainingSeconds: values.plannedSeconds,
      status: 'queued',
      updatedAt: nowIso(),
      ownerInterpreters: {}
    });
    appendLedger(state, 'speech', state.activeRoomId, `${values.speaker} 已加入发言队列`);
  });

  /** 临时插话：插入到当前发言段之后 */
  const interruptSpeech$ = $((values: QueueForm) => {
    const speaking = state.speechQueue.find((item) => item.roomId === state.activeRoomId && item.status === 'speaking');
    const newSpeech: Speech = {
      id: uuid(),
      roomId: state.activeRoomId,
      ...values,
      remainingSeconds: values.plannedSeconds,
      status: 'queued',
      updatedAt: nowIso(),
      ownerInterpreters: {}
    };
    if (speaking) {
      const idx = state.speechQueue.findIndex((item) => item.id === speaking.id);
      state.speechQueue = [...state.speechQueue.slice(0, idx + 1), newSpeech, ...state.speechQueue.slice(idx + 1)];
    } else {
      state.speechQueue.unshift(newSpeech);
    }
    appendLedger(state, 'speech', state.activeRoomId, `临时插话：${values.speaker} 已插入发言队列`, newSpeech.id);
  });

  const approveTerm$ = $((id: string) => {
    const term = state.terms.find((t) => t.id === id);
    state.terms = state.terms.map((t) => (t.id === id ? { ...t, approved: true } : t));
    appendLedger(state, 'term', state.activeRoomId, `术语已批准：${term?.phrase}`, id);
  });

  const speech = currentSpeech();
  const channel = currentChannel();
  const caption = currentCaption();
  const baseStale = !!caption && caption.revision > captionBaseRevision.value;

  return (
    <main class={`conference-shell ${state.lowLatency ? 'low-latency' : ''}`}>
      <header class="hero">
        <div>
          <span class="pill">{locale.lang}</span>
          <h1>同声传译与发言队列</h1>
          <p>{activeRoom().name} · {activeRoom().topic}</p>
        </div>
        <div style="display:flex;gap:12px;flex-wrap:wrap">
          <select value={state.activeRoomId} onChange$={(event) => selectRoom$((event.target as HTMLSelectElement).value)}>
            {state.rooms.map((room) => <option value={room.id} key={room.id}>{room.name}</option>)}
          </select>
          <button class="secondary" onClick$={toggleLowLatency$}>
            {state.lowLatency ? '退出低延迟' : '低延迟模式'}
          </button>
        </div>
      </header>

      <section class="grid">
        <article class="panel">
          <div style="display:flex;justify-content:space-between;align-items:center">
            <h2>发言队列</h2>
            <span class="pill">{roomQueue().length} 条 · {activeRoom().simultaneousChannels} 个同传频道</span>
          </div>
          {roomQueue().map((item, index) => (
            <div class={`queue-row ${item.status === 'speaking' ? 'active' : ''}`} key={item.id}>
              <strong>#{index + 1}</strong>
              <div>
                <b>{item.speaker}</b>
                <div style="color:#638087;font-size:13px">
                  {item.delegation} · {item.language} · {item.topic}
                  {item.status === 'speaking' && Object.keys(item.ownerInterpreters).length > 0 && (
                    <span class="pill" style="margin-left:6px">
                      归属译员：{Object.entries(item.ownerInterpreters).map(([l, i]) => `${l} ${i}`).join(' / ')}
                    </span>
                  )}
                </div>
              </div>
              <span class="pill">{item.status}</span>
              <div style="display:flex;gap:6px;flex-wrap:wrap">
                {item.status === 'queued' && <button onClick$={() => advanceSpeech$(item.id, 'speaking')}>开始</button>}
                {item.status === 'speaking' && (
                  <>
                    <button onClick$={() => advanceSpeech$(item.id, 'done')}>结束</button>
                    <button class="secondary" onClick$={() => jumpToNext$(item.id)}>跳到下一段</button>
                    <button class="secondary" onClick$={() => (item.remainingSeconds = Math.max(0, item.remainingSeconds - 60))}>减1分钟</button>
                  </>
                )}
                {item.status === 'queued' && <button class="danger" onClick$={() => advanceSpeech$(item.id, 'skipped')}>跳过</button>}
              </div>
            </div>
          ))}
          <div style="margin-top:18px">
            <div style="display:flex;gap:8px;margin-bottom:10px">
              <button
                class={queueMode.value === 'interrupt' ? 'danger' : 'secondary'}
                onClick$={() => (queueMode.value = queueMode.value === 'interrupt' ? 'normal' : 'interrupt')}
              >
                {queueMode.value === 'interrupt' ? '取消插话' : '临时插话'}
              </button>
              {queueMode.value === 'interrupt' && <span class="pill">插话将插入当前发言段之后</span>}
            </div>
            <QueueForm onSubmit$={(values) => (queueMode.value === 'interrupt' ? interruptSpeech$(values) : addSpeech$(values))}>
              <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
                <QueueField name="speaker">{(field, props) => <input {...props} value={field.value} onInput$={(event) => (field.value = (event.target as HTMLInputElement).value)} placeholder="发言人" />}</QueueField>
                <QueueField name="delegation">{(field, props) => <input {...props} value={field.value} onInput$={(event) => (field.value = (event.target as HTMLInputElement).value)} placeholder="代表团" />}</QueueField>
                <QueueField name="topic">{(field, props) => <input {...props} value={field.value} onInput$={(event) => (field.value = (event.target as HTMLInputElement).value)} placeholder="议题" />}</QueueField>
                <QueueField name="plannedSeconds" type="number">{(field, props) => <input {...props} type="number" value={field.value} onInput$={(event) => (field.value = Number((event.target as HTMLInputElement).value))} placeholder="计划秒数" />}</QueueField>
              </div>
              <button type="submit" style="margin-top:10px">{queueMode.value === 'interrupt' ? '插入插话' : '加入队列'}</button>
            </QueueForm>
          </div>
        </article>

        <aside class="panel">
          <h2>频道与译员</h2>
          {roomChannels().map((ch) => (
            <div style="padding:12px 0;border-bottom:1px solid #e6efee" key={ch.id}>
              <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:6px">
                <b>
                  {ch.language} · {ch.interpreter}
                  {ch.status === 'handoff' && ch.pendingInterpreter && (
                    <span style="color:#c2413b;font-weight:normal"> → {ch.pendingInterpreter}（交接中）</span>
                  )}
                </b>
                <span class="pill">{ch.status}</span>
              </div>
              <div class="decorative" style="margin:8px 0"><Progress.Root value={ch.health} max={100} /></div>
              <div style="display:flex;gap:8px">
                {ch.status === 'active' && <button class="secondary" onClick$={() => handoff$(ch.id)}>开始交接</button>}
                {ch.status === 'handoff' && <button onClick$={() => completeHandoff$(ch.id)}>完成交接</button>}
              </div>
            </div>
          ))}

          <h3>实时字幕修正</h3>
          {speech && channel ? (
            <form
              onSubmit$={(event) => {
                event.preventDefault();
                publishCaption$({ text: captionText.value });
              }}
            >
              {channel.status === 'handoff' && channel.pendingInterpreter && (
                <label style="display:block;margin-bottom:8px;font-size:13px;color:#59747b">
                  提交译员：
                  <select
                    value={captionInterpreter.value}
                    onChange$={(event) => (captionInterpreter.value = (event.target as HTMLSelectElement).value)}
                  >
                    <option value={channel.interpreter}>{`${channel.interpreter}（原译员）`}</option>
                    <option value={channel.pendingInterpreter}>{`${channel.pendingInterpreter}（接手人）`}</option>
                  </select>
                </label>
              )}
              <textarea
                rows={3}
                value={captionText.value}
                onInput$={(event) => (captionText.value = (event.target as HTMLTextAreaElement).value)}
                placeholder="输入或修正当前字幕"
                style="width:100%"
              />
              <div style="display:flex;justify-content:space-between;align-items:center;margin-top:6px">
                <small style="color:#638087">
                  编辑基于 v{captionBaseRevision.value}
                  {baseStale && caption ? ` · 当前已生效 v${caption.revision}` : ''}
                </small>
                {baseStale && caption && (
                  <button type="button" class="secondary" onClick$={refreshBase$}>刷新到 v{caption.revision}</button>
                )}
              </div>
              <button type="submit" style="margin-top:8px">提交新版字幕</button>
            </form>
          ) : (
            <p>当前没有发言中的代表。</p>
          )}

          {captionConflict.value && (
            <div class="conflict-panel">
              <b>冲突编号 {captionConflict.value.id}</b>
              <p>当前版本 v{captionConflict.value.currentRevision}：{captionConflict.value.currentText}</p>
              <small>先到版本生效，后到译员请查看当前版本后再提交</small>
              <button type="button" class="secondary" onClick$={adoptCurrent$} style="margin-top:6px">基于当前版本修改</button>
            </div>
          )}

          {state.captions
            .filter((c) => c.roomId === state.activeRoomId && c.status !== 'superseded')
            .map((c) => (
              <div class="caption-row" key={c.id}>
                <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:6px">
                  <b>{c.interpreter} · v{c.revision}</b>
                  <span class="pill">{c.status}</span>
                </div>
                <p>{c.text}</p>
                {c.status === 'invalid' && c.recalcError && (
                  <div class="recalc-error">
                    <small>重算失败：{c.recalcError}</small>
                    <button class="secondary" onClick$={() => retryRecalculation$(c.id)}>重试重算</button>
                  </div>
                )}
                {c.status === 'draft' && (
                  <button class="secondary" onClick$={() => confirmCaption$(c.id)}>确认版本</button>
                )}
              </div>
            ))}
        </aside>
      </section>

      <section class="grid" style="margin-top:18px">
        <article class="panel">
          <h2>术语库</h2>
          {state.terms.map((term) => (
            <div class="queue-row" key={term.id}>
              <span />
              <div>
                <b>{term.phrase}</b>
                <div>{term.translation} · {term.language}</div>
              </div>
              <span class="pill">{term.approved ? '已批准' : '待审'}</span>
              <button disabled={term.approved} onClick$={() => approveTerm$(term.id)}>批准</button>
            </div>
          ))}
        </article>
        <article class="panel">
          <h2>时间账</h2>
          {state.ledger
            .filter((l) => l.roomId === state.activeRoomId)
            .slice(0, 12)
            .map((l) => (
              <div class="ledger-row" key={l.id}>
                <small>{new Date(l.at).toLocaleTimeString()}</small>
                <div>{l.message}</div>
              </div>
            ))}
        </article>
      </section>
    </main>
  );
});

export const head: DocumentHead = {
  title: '国际会议同声传译控制台',
  meta: [{ name: 'description', content: '发言队列、多语种频道、术语、译员交接与实时字幕修正原型' }]
};
