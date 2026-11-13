# Архитектура

> Перед чтением: [`README.md`](README.md) · [`../README.md`](../README.md)

## Одним абзацем

Плагин регистрирует **агентно-локальный клон** каждого перехватываемого
инструмента на корневом агенте. Клон затеняет настоящий инструмент только для
этого агента. Вызов клона уходит в **воркер** — дочерний субагент, который сам
вызывает настоящий инструмент и отвечает `OK`; основной агент получает
**результат инструмента из воркера**, а не транскрипт работы. Воркер один на
тип задачи, живёт между вызовами и пересоздаётся по таймауту, лимиту вызовов,
окружению и лимиту контекста.

## Компоненты

| Слой | Файл | Ответственность |
|---|---|---|
| Host-плагин | [`index.js`](../index.js) | `Config`, `apply`, клоны, воркеры, 3 глобальных инструмента, `agent/pre-step` |
| Web-клиент | [`client.js`](../client.js) | Страница в двух вкладках (настройки / README), словари en/ru, сохранение через remote API. Встроенный текст README — блок между маркерами `README-НАЧАЛО`/`README-КОНЕЦ`, собирается `scripts/build-readme.mjs`. **Требует только `react`:** любой другой `require` роняет запуск DSH (D19) |
| Bundle | [`cordis.patch.yml`](../cordis.patch.yml) | Строка `delegate-io` со значениями по умолчанию |
| Локализация строки | [`locale/en.json`](../locale/en.json), [`locale/ru.json`](../locale/ru.json) | Заголовок/описание в списке плагинов |

`index.js` объявляет `inject = ['tools', 'subagents', 'agents']` и дополнительно
использует сервисы через `ctx.get(...)`: `fs`, `settings`, `spillStore`,
`sandboxPolicy`, `tokenMeter`, `compaction`.

## Поток одного делегированного вызова

```
Основной агент
     вызывает `read` (это клон)
  ▼
shadow.execute(args, exec)                        index.js:1585
  ├─ вызывающий не корневой агент?      → настоящий инструмент
  ├─ `${task}Enabled` = false?           → retireIdleWorker + настоящий инструмент
  ├─ dispatch(state, task, …)             index.js:1525
       └─ pickWorker (read/web/think) или fileWorker (write/edit)
           └─ очередь выбранного слота worker.chain
               └─ runJob(...)                 index.js:1358
                ├─ refreshWorkerEnvironment  (перепривязка, без замены)
                ├─ compactWorkerIfOverLimit  (замена по лимиту контекста)
                ├─ prepareVerification    (только write/edit)
                ├─ startWorkerJob | continueWorkerJob
                      └─ ctx.subagents.startActivation / sendMessage
                            └─ воркер вызывает НАСТОЯЩИЙ инструмент
                            └─ наблюдатель ловит последний `tool/result`
                ├─ settleVerification     (только write/edit)
                └─ capResult              → спилл при превышении бюджета
  ├─ успех  → { 'delegate-io': { text } }
  └─ ошибка → fallbackToDirect ? настоящий инструмент (+ hint) : throw
  ▼
Основной агент получает текст результата
```

## Клоны инструментов

`mount(state, task)` — [`index.js:1554`](../index.js).

Для каждого инструмента из `TASKS`:

1. `real = ctx.tools.get(toolName, state.agent)` — настоящий инструмент.
2. `state.tools.set(toolName, real)` — нужен для автоисправления `edit`.
3. Собирается `shadow` — копия с тем же `name`, `parameters`, `deferLoading`,
   `timeoutMs`, `presentCall`; описание дополняется фразой о делегировании.
4. `output.schema = delegatedValueSchema(real)` — `oneOf` из настоящей схемы и
   конверта `{ 'delegate-io': { text } }`.
5. `output.render` понимает оба варианта.
6. `isConcurrencySafe: () => true` — вызовы одного клона можно запускать
   параллельно; фактическая параллельность и её границы — пул воркеров:
   `read`/`web`/`think` расходятся по наименее занятому слоту, `write`/`edit`
   привязаны к слоту своего `file_path`, поэтому изменения одного файла
   сериализуются.
7. `agent.ctx.tools.register(shadow)` — регистрация **на агенте**, а не глобально.

> **Почему клон, а не перехват.** Клон живёт в контексте конкретного агента,
> поэтому делегированный ребёнок, унаследовав клон, всё равно спускается к
> настоящему инструменту: в `execute` есть проверка
> `caller.id !== state.agent.id`, и при несовпадении вызов уходит в `real`,
> минуя `dispatch`. Так исключено бесконечное делегирование.

## Наблюдение за воркером

`ctx.on('session/event', ...)` — [`index.js:887`](../index.js).

`workersByChild` отображает `childId → { state, worker }`. Пока у воркера есть
активная `observation`, события дочерней сессии собираются так:

- `assistant/message` → `observation.answer` (для job’ов `capture: 'answer'`);
- `tool/result` → `observation.text`, `observation.usedTool = true`,
  `observation.failed` (по `event.data.error` или `message.isError`);
- `turn/end` → `observation.finish()` разрешает промис.

Поэтому **результат никогда не зависит от того, как воркер его перескажет**:
инструментом возвращает не ответ модели, а событие `tool/result`.

## Сигналы и таймауты

- `withTimeout` — [`index.js:796`](../index.js): гонка работы и `setTimeout`
  на `requestTimeoutMs`; в `finally` проверяется `signal.aborted`.
- На таймауте/отмене вызывается `interruptWorker` (`ctx.subagents.interrupt`) —
  воркер гасится, а не остаётся висеть.

## Глобальные инструменты

`delegate_think`, `delegate_inspect`, `delegate_io_status` регистрируются
глобально (`ctx.tools.register`) и доступны **только корневому агенту**:
они проверяют `roots.get(caller.id)`. Подробно — [`tools.md`](tools.md).

## `agent/pre-step`

[`index.js:1551`](../index.js):

```js
ctx.on('agent/pre-step', async (payload, next) =>
  filterPreStep(roots.get(payload.agent.id), await next()));
```

`filterPreStep` вычищает из пачки сообщений уведомления
«Background subagent … finished» **своих** воркеров (`withoutWorkerNotices`,
[`index.js:191`](../index.js)). Пачка может стать пустой — это намеренно,
см. [`decisions.md`](decisions.md#d1-pre-step-не-может-отказать-в-шаге).

## Инварианты

Нарушение любого из них — регрессия.

1. **Каждое поле `Config` — `.volatile()`.** Хост отвергает сохранение формы
   с `Config field "<key>" is not volatile`. Проверяется `test/schema.test.mjs`.
2. **Клон регистрируется даже при выключенной задаче.** Иначе включение в
   живой сессии не подхватится.
3. **`*Enabled` читается на каждом вызове**, не при регистрации.
4. **Fallback.** При `fallbackToDirect` сбой воркера не должен блокировать
   работу — инструмент выполняется напрямую.
5. **Ошибка верификации не уходит в fallback.** `error.delegateIoVerification`
   перебрасывается: файл уже исправлен, повторный `edit` применился бы дважды.
6. **`pre-step` не отказывает.** Может вернуть пустую `enter`-пачку, но не
   `reject`/`blocked`.
7. **Отчёт без вызова инструмента невалиден.** `capture: 'answer'` требует
   `usedTool === true`, если не задано `requireTool: false` (только thinker).
8. **Воркер — слот пула, и воркеров ровно `WORKERS_PER_TASK[task]`.** Каждый
   слот обслуживает вызовы своей задачи и заменяется **только** по
   исчерпанному лимиту контекста: простоя, счётчика вызовов, смены окружения,
   ошибки вызова, незавершившегося хода и пропавшего ребёнка недостаточно.
   Проверяется `test/worker-lifetime.test.mjs`, `test/context-limit.test.mjs`
   и `test/pool.test.mjs`. См. [`decisions.md`](decisions.md) → D25.
9. **Изменения одного файла сериализуются — по каноническому пути.** `write`/`edit`
   берут файловый шлюз (`withFileGate` по ключу `fileKeyOf`: `path.resolve` от
   `cwd` плюс нижний регистр на Windows) на всё задание, включая верификацию и
   fallback. Слот по `file_path` выбирается для тёплой истории, но гарантией не
   является: `a.txt` и `./a.txt` хэшируются в разные слоты. Два одновременных
   изменения одного файла предсказывали бы результат от одного снимка, и
   автоисправление второго потеряло бы первую правку. Ломать это — терять
   данные, а не скорость.
10. **Результат воркера берётся из событий**, а не из ответа модели.
11. **Всё, что может не сработать, деградирует явно** — через `ctx.logger.warn`
    и корректный fallback, без «немого» пустого результата.

## Жизненный цикл состояния

- `roots: Map<agentId, state>` — по состоянию на корневого агента; создаётся в
  `track(agent)`, вызываемом из `ctx.on('agent/created')` и при старте для
  `ctx.agents.list()`.
- `agent.ctx.effect(..., 'delegate-io: agent lifetime')` освобождает воркеров и
  регистрации при смерти агента.
- `ctx.effect(..., 'delegate-io: release all agents')` — глобальный teardown
  при выгрузке плагина.

## Куда не лезть без необходимости

- `test/probe.test.mjs` фиксирует контракт `ctx.agents.get`/`list` и
  `activation.dispose()` — это зонд поведения runtime. Менять логику поиска
  воркера (`liveWorkerAgent`) можно только вместе с ним.
- `recycleChild` вызывается только из `compactWorkerIfOverLimit` (штатная
  замена) и `recycleAll` (закрытие агента/выгрузка). Любой новый вызов
  `recycleChild` — нарушение инварианта 8; подробности в
  [`decisions.md`](decisions.md) → D15.
- `WORKERS_PER_TASK` — константа, а не поле `Config`. Форма настроек и
  `cordis.patch.yml` от пула не меняются; новый размер пула — правка кода и
  документации, а не конфигурации.
- `contextTokensOf` использует `surfaceTokens`; замена на `contextPressure`
  уже была регрессией — см. [`decisions.md`](decisions.md).
