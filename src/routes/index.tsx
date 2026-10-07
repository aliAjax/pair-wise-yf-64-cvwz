import { $, component$, useSignal, useStore, useVisibleTask$ } from '@builder.io/qwik';
import { Progress } from '@qwik-ui/headless';
import { QueryClient } from '@tanstack/query-core';
import { setValue, useForm, zodForm$ } from '@modular-forms/qwik';
import { useSpeakLocale } from 'qwik-speak';
import { z } from 'zod';
import type { DocumentHead } from '@builder.io/qwik-city';
import {
  STORAGE_KEY,
  assignmentsOf,
  attemptRecalc,
  cancelHandoff,
  chainHead,
  confirmCaption,
  confirmHandoff,
  currentSpeech,
  endSpeech,
  enqueueSpeech,
  log,
  pendingHandoff,
  pruneForLowLatency,
  readState,
  requestHandoff,
  seedState,
  skipQueued,
  skipToNext,
  startSpeech,
  submitCaption,
  switchRoom,
  type ConferenceState,
  type LedgerKind,
  type SubmitResult
} from '~/lib/timeline';

const captionSchema = z.object({
  language: z.string().min(1),
  submittedBy: z.string().min(1, '请选择提交译员'),
  text: z.string().min(1, '字幕不能为空')
});
type CaptionForm = z.infer<typeof captionSchema>;

const queueSchema = z.object({
  speaker: z.string().min(2, '请输入发言人'),
  delegation: z.string().min(2, '请输入代表团'),
  language: z.string().min(2),
  topic: z.string().min(3, '请输入议题'),
  plannedSeconds: z.coerce.number().min(60).max(3600)
});
type QueueForm = z.infer<typeof queueSchema>;

const KIND_LABELS: Record<LedgerKind, string> = {
  queue: '队列',
  'segment-start': '发言开始',
  'segment-end': '发言结束',
  'handoff-request': '交接发起',
  'handoff-confirm': '交接确认',
  'handoff-cancel': '交接取消',
  'caption-accepted': '字幕生效',
  'caption-confirmed': '字幕确认',
  'caption-conflict': '字幕冲突',
  'caption-invalidated': '译文失效',
  'recalc-success': '重算成功',
  'recalc-failed': '重算失败',
  'room-switch': '切厅',
  'low-latency': '低延迟'
};

const STATE_LABELS = { pending: '待确认', confirmed: '已确认', invalidated: '已失效' } as const;

const queryClient = new QueryClient();

const fmtSeconds = (value: number) => `${Math.floor(value / 60)}分${String(value % 60).padStart(2, '0')}秒`;

export default component$(() => {
  const locale = useSpeakLocale();
  const state = useStore<ConferenceState>(seedState());
  const submitResult = useSignal<SubmitResult | null>(null);
  const captionChannel = useSignal('中文');
  const handoffNames = useStore<Record<string, string>>({});

  const captionLoader = useSignal<CaptionForm>({ language: '中文', submittedBy: '周雨', text: '' });
  const [captionForm, { Form: CaptionFormView, Field: CaptionField }] = useForm<CaptionForm>({
    loader: captionLoader,
    validate: zodForm$(captionSchema)
  });
  const queueLoader = useSignal<QueueForm>({ speaker: '', delegation: '', language: '英语', topic: '', plannedSeconds: 300 });
  const [queueForm, { Form: QueueFormView, Field: QueueField }] = useForm<QueueForm>({
    loader: queueLoader,
    validate: zodForm$(queueSchema)
  });

  // 挂载时恢复本地存档，之后任何变动都落盘
  useVisibleTask$(() => {
    Object.assign(state, readState(localStorage));
  });
  useVisibleTask$(({ track }) => {
    track(() => JSON.stringify(state));
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  });

  const activeRoom = () => state.rooms.find((room) => room.id === state.activeRoomId) ?? state.rooms[0];
  const roomQueue = () => state.speechQueue.filter((item) => item.roomId === state.activeRoomId);
  const roomChannels = () => state.channels.filter((item) => item.roomId === state.activeRoomId);
  const speaking = () => currentSpeech(state, state.activeRoomId);
  const roomLedger = () => state.ledger.filter((entry) => entry.roomId === state.activeRoomId);
  const openRecalcTasks = () => state.recalcTasks.filter((item) => item.roomId === state.activeRoomId && item.status !== 'done');
  const selectedChannel = () => roomChannels().find((item) => item.language === captionChannel.value);
  const submitterOptions = () => {
    const channel = selectedChannel();
    if (!channel) return [];
    const options = [channel.interpreter];
    const handoff = pendingHandoff(state, channel.id);
    if (handoff) options.push(handoff.toInterpreter);
    options.push('实习译员（未登记）');
    return options;
  };

  const selectRoom$ = $((roomId: string) => {
    switchRoom(state, roomId);
    const first = state.channels.find((item) => item.roomId === roomId);
    if (first) {
      captionChannel.value = first.language;
      setValue(captionForm, 'language', first.language);
      setValue(captionForm, 'submittedBy', first.interpreter);
    }
    submitResult.value = null;
  });

  const publishCaption$ = $(async (values: CaptionForm) => {
    submitResult.value = await queryClient.fetchQuery({
      queryKey: ['caption-submit', state.activeRoomId, values.language, values.submittedBy, values.text],
      queryFn: async () => submitCaption(state, { roomId: state.activeRoomId, ...values }),
      staleTime: 0
    });
  });

  const toggleLowLatency$ = $(() => {
    state.lowLatency = !state.lowLatency;
    if (state.lowLatency) pruneForLowLatency(state, state.activeRoomId);
    else log(state, state.activeRoomId, 'low-latency', '退出低延迟模式，恢复完整时间账视图');
  });

  const approveTerm$ = $((id: string) => {
    const term = state.terms.find((item) => item.id === id);
    if (!term) return;
    term.approved = true;
    log(state, state.activeRoomId, 'queue', `术语已批准：${term.phrase}`);
  });

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
          <button class="secondary" onClick$={toggleLowLatency$}>{state.lowLatency ? '退出低延迟' : '低延迟模式'}</button>
        </div>
      </header>

      <section class="screen">
        <div class="screen-head">
          <span class="pill">大屏预览</span>
          {speaking() ? (
            <h2>{speaking()!.speaker} · {speaking()!.topic}</h2>
          ) : (
            <h2 class="dim">暂无发言，上一段未确认译文已失效</h2>
          )}
        </div>
        {speaking() && (
          <div class="screen-captions">
            {roomChannels().filter((item) => item.status !== 'standby').map((channel) => {
              const head = chainHead(state, speaking()!.id, channel.language);
              return (
                <div class="screen-line" key={channel.id}>
                  <b>{channel.language}</b>
                  {head ? (
                    <span>{head.text} <small>v{head.revision} · {head.interpreter}{head.state === 'pending' ? ' · 待确认' : ''}</small></span>
                  ) : (
                    <span class="dim">等待字幕…</span>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>

      <section class="grid">
        <article class="panel">
          <div style="display:flex;justify-content:space-between;align-items:center">
            <h2>发言队列</h2>
            <span class="pill">{roomQueue().length} 条 · {activeRoom().simultaneousChannels} 个同传频道</span>
          </div>
          {roomQueue().map((speech, index) => (
            <div class={`queue-row ${speech.status === 'speaking' ? 'active' : ''}`} key={speech.id}>
              <strong>#{index + 1}</strong>
              <div>
                <b>{speech.speaker}</b>
                <div style="color:#638087;font-size:13px">{speech.delegation} · {speech.language} · {speech.topic} · 剩余 {fmtSeconds(speech.remainingSeconds)}</div>
                {speech.status === 'speaking' && (
                  <div class="chips">
                    {assignmentsOf(state, speech.id).map((item) => <span class="chip" key={item.id}>{item.language}·{item.interpreter}</span>)}
                  </div>
                )}
              </div>
              <span class="pill">{speech.status}</span>
              <div style="display:flex;gap:6px;flex-wrap:wrap">
                {speech.status === 'queued' && <button onClick$={() => startSpeech(state, state.activeRoomId, speech.id)}>开始</button>}
                {speech.status === 'speaking' && (
                  <>
                    <button onClick$={() => endSpeech(state, speech.id, 'done')}>结束</button>
                    <button class="secondary" onClick$={() => skipToNext(state, state.activeRoomId)}>跳到下一段</button>
                    <button class="secondary" onClick$={() => speech.remainingSeconds = Math.max(0, speech.remainingSeconds - 60)}>减1分钟</button>
                  </>
                )}
                {speech.status === 'queued' && <button class="danger" onClick$={() => skipQueued(state, speech.id)}>跳过</button>}
              </div>
            </div>
          ))}
          <QueueFormView onSubmit$={(values) => enqueueSpeech(state, values)}>
            <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-top:18px">
              <QueueField name="speaker">{(field, props) => <input {...props} value={field.value} onInput$={(event) => field.value = (event.target as HTMLInputElement).value} placeholder="发言人" />}</QueueField>
              <QueueField name="delegation">{(field, props) => <input {...props} value={field.value} onInput$={(event) => field.value = (event.target as HTMLInputElement).value} placeholder="代表团" />}</QueueField>
              <QueueField name="language">{(field, props) => (
                <select {...props} value={field.value} onInput$={(event) => field.value = (event.target as HTMLSelectElement).value}>
                  {['英语', '中文', '法语', '西班牙语', '葡萄牙语', '阿拉伯语', '俄语'].map((lang) => <option value={lang} key={lang}>{lang}</option>)}
                </select>
              )}</QueueField>
              <QueueField name="topic">{(field, props) => <input {...props} value={field.value} onInput$={(event) => field.value = (event.target as HTMLInputElement).value} placeholder="议题" />}</QueueField>
              <QueueField name="plannedSeconds" type="number">{(field, props) => <input {...props} type="number" value={field.value} onInput$={(event) => field.value = Number((event.target as HTMLInputElement).value)} placeholder="计划秒数" />}</QueueField>
              <button type="submit">加入队列</button>
            </div>
          </QueueFormView>
        </article>

        <aside class="panel">
          <h2>频道与译员交接</h2>
          {roomChannels().map((channel) => {
            const handoff = pendingHandoff(state, channel.id);
            return (
              <div style="padding:12px 0;border-bottom:1px solid #e6efee" key={channel.id}>
                <div style="display:flex;justify-content:space-between"><b>{channel.language} · {channel.interpreter}</b><span class="pill">{channel.status}</span></div>
                <div class="decorative" style="margin:8px 0"><Progress.Root value={channel.health} max={100} /></div>
                {handoff ? (
                  <div class="handoff-pending">
                    <span>待确认：{handoff.fromInterpreter} → {handoff.toInterpreter}，确认前字幕仍归 {handoff.fromInterpreter}</span>
                    <div style="display:flex;gap:6px">
                      <button onClick$={() => confirmHandoff(state, channel.id)}>确认交接</button>
                      <button class="secondary" onClick$={() => cancelHandoff(state, channel.id)}>取消</button>
                    </div>
                  </div>
                ) : (
                  <div style="display:flex;gap:8px">
                    <input
                      placeholder="接手译员姓名"
                      value={handoffNames[channel.id] ?? ''}
                      onInput$={(event) => handoffNames[channel.id] = (event.target as HTMLInputElement).value}
                    />
                    <button class="secondary" onClick$={() => { requestHandoff(state, channel.id, handoffNames[channel.id] ?? ''); handoffNames[channel.id] = ''; }}>发起交接</button>
                  </div>
                )}
              </div>
            );
          })}

          <h3>实时字幕提交</h3>
          {speaking() ? (
            <>
              <CaptionFormView onSubmit$={publishCaption$}>
                <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px">
                  <CaptionField name="language">{(field, props) => (
                    <select
                      {...props}
                      value={field.value}
                      onInput$={(event) => {
                        const lang = (event.target as HTMLSelectElement).value;
                        field.value = lang;
                        captionChannel.value = lang;
                        const channel = state.channels.find((item) => item.roomId === state.activeRoomId && item.language === lang);
                        setValue(captionForm, 'submittedBy', channel?.interpreter ?? '');
                      }}
                    >
                      {roomChannels().map((channel) => <option value={channel.language} key={channel.id}>{`${channel.language}频道`}</option>)}
                    </select>
                  )}</CaptionField>
                  <CaptionField name="submittedBy">{(field, props) => (
                    <select {...props} value={field.value} onInput$={(event) => field.value = (event.target as HTMLSelectElement).value}>
                      {submitterOptions().map((name) => <option value={name} key={name}>{name}</option>)}
                    </select>
                  )}</CaptionField>
                </div>
                <CaptionField name="text">{(field, props) => <textarea {...props} rows={3} value={field.value} onInput$={(event) => field.value = (event.target as HTMLTextAreaElement).value} placeholder="输入或修正当前字幕" />}</CaptionField>
                <button type="submit" style="margin-top:8px">提交字幕</button>
              </CaptionFormView>
              {submitResult.value && (
                submitResult.value.ok ? (
                  <div class="notice ok">v{submitResult.value.revision} 已生效 · 归属 {submitResult.value.interpreter}{submitResult.value.transferred ? ' · 交接后转至接手人' : ''}</div>
                ) : submitResult.value.kind === 'conflict' ? (
                  <div class="notice conflict">冲突 C-{submitResult.value.conflictNo} · 当前版本 {submitResult.value.currentRevision !== null ? `v${submitResult.value.currentRevision}（${submitResult.value.currentInterpreter}）` : '暂无'}</div>
                ) : (
                  <div class="notice rejected">{submitResult.value.reason}</div>
                )
              )}
              <div style="margin-top:12px">
                {state.captions.filter((item) => item.speechId === speaking()!.id).map((caption) => (
                  <div class={`caption-row ${caption.state}`} key={caption.id}>
                    <div style="display:flex;justify-content:space-between;align-items:center">
                      <b>{caption.language} · {caption.interpreter} · v{caption.revision}</b>
                      <span class={`pill state-${caption.state}`}>{STATE_LABELS[caption.state]}</span>
                    </div>
                    <p>{caption.text}</p>
                    <small>
                      {caption.submittedBy !== caption.interpreter ? `${caption.submittedBy} 提交 · ` : ''}
                      {caption.recalculatedFrom ? '按新发言人重算 · ' : ''}
                      {new Date(caption.at).toLocaleTimeString()}
                    </small>
                    {caption.state === 'pending' && (
                      <button class="secondary" style="margin-left:8px" onClick$={() => confirmCaption(state, caption.id)}>确认</button>
                    )}
                  </div>
                ))}
              </div>
            </>
          ) : (
            <p>当前没有发言中的代表。</p>
          )}

          {openRecalcTasks().length > 0 && (
            <>
              <h3>未确认译文重算</h3>
              {openRecalcTasks().map((task) => (
                <div class="recalc-row" key={task.id}>
                  <div>
                    <b>{task.language} 译文</b>
                    <small>{task.status === 'failed' ? `重算失败：${task.lastError}` : '等待重算'} · 已试 {task.attempts} 次 · 原版本已保留</small>
                  </div>
                  <button class="secondary" onClick$={() => {
                    const target = state.recalcTasks.find((item) => item.id === task.id);
                    if (target) attemptRecalc(state, target);
                  }}>重试</button>
                </div>
              ))}
            </>
          )}
        </aside>
      </section>

      <section class="grid" style="margin-top:18px">
        {!state.lowLatency && (
          <article class="panel">
            <h2>术语库</h2>
            {state.terms.map((term) => (
              <div class="queue-row" key={term.id}>
                <span />
                <div><b>{term.phrase}</b><div>{term.translation} · {term.language}</div></div>
                <span class="pill">{term.approved ? '已批准' : '待审'}</span>
                <button disabled={term.approved} onClick$={() => approveTerm$(term.id)}>批准</button>
              </div>
            ))}
          </article>
        )}
        <article class="panel" style={state.lowLatency ? 'grid-column:1/-1' : ''}>
          <h2>时间账{state.lowLatency ? '（低延迟：仅当前段关键状态）' : ''}</h2>
          {roomLedger().slice(0, state.lowLatency ? 8 : 15).map((entry) => (
            <div class="ledger-row" key={entry.id}>
              <small>#{entry.seq} · {new Date(entry.at).toLocaleTimeString()}</small>
              <span class={`kind kind-${entry.kind}`}>{KIND_LABELS[entry.kind]}</span>
              <div>{entry.message}</div>
            </div>
          ))}
        </article>
      </section>
    </main>
  );
});

export const head: DocumentHead = {
  title: '国际会议同声传译控制台',
  meta: [{ name: 'description', content: '发言队列、译员交接与字幕版本接成一条时间账的同传控制台' }]
};
