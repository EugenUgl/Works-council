# Глобальные инструменты

> Предварительно: [`architecture.md`](architecture.md), [`results-and-budget.md`](results-and-budget.md)

Все три инструмента регистрируются глобально (`ctx.tools.register`) и **доступны
только корневому агенту**: каждый проверяет `roots.get(caller.id)` и бросает
`delegate-io: <tool> is available to the main agent only`, если агент не
отслеживается. Делегированные дети их не видят как «свои» — их вызов ушёл бы
просто в никуда.

---

## `delegate_think` — [`index.js:1631`](../index.js)

Эскалация к **рассуждающему воркеру**, когда рассуждение — узкое место.

### Параметры

| Параметр | Тип | Обяз. | Смысл |
|---|---|---|---|
| `question` | string | да | Что решить, в одном-двух предложениях |
| `evidence` | string | да | Точные ошибки, пути, вывод, попытки — **дословно** |

### Как работает

1. Требует `thinkEnabled`; иначе `delegate-io: the thinking worker is switched off`.
2. `dispatch(state, 'think', ..., { capture: 'answer', prompt: thinkPrompt(args), verify: false, remember: true, requireTool: false })`.
3. Ответ парсится `parseThinkReply` — [`index.js:317`](../index.js).
4. Невалидный ответ → `thinkFailed += 1` → ошибка
   `the thinker replied without a valid decision object`.
5. `{"need": "..."}` → `thinkAsks += 1`, возвращается `needText`.
6. Иначе — `thoughtText`: `delegate-io think: <вопрос>`, `diagnosis:`, `next step:`.

### Протокол ответа

Воркер обязан вернуть **один** JSON-объект:

```json
{"diagnosis": "...", "evidence": ["..."], "nextStep": "...", "risks": ["..."], "confidence": "high|medium|low"}
```

или, если не хватает факта:

```json
{"need": "<чего не хватает>"}
```

`parseThinkReply`: берёт подстроку от первого `{` до последнего `}`, парсит,
отбрасывает массивы/`null`. Основное правило — **`need` и `diagnosis`
взаимоисключающие**: если заданы оба, ответ невалиден.

### Цикл уточнений

Воркер без инструментов **ничего не читает сам**. Он может запросить факт;
основной агент получает текст «нужен такой-то факт» и вызывает инструмент
снова, добавив факт в `evidence`. Раундов не больше `thinkMaxTurns`
(по умолчанию 2); при `0` промпт запрещает вопросы полностью.

### Гейт эскалации

`noteOutcome` / `escalateHint` / `hintResult` / `overallFailureHint` —
[`index.js:1333`](../index.js) и далее. Два независимых триггера:

**1. Один инструмент падает подряд.** Считается в `state.failuresByTool`.
После `thinkEscalateAfter` (по умолчанию 2; `0` — выключено) к результату
дописывается:

```
[delegate-io: "<tool>" has failed N times in a row — this is the point for
delegate_think: pass the exact errors above as evidence and let it decide]
```

**2. Не сходится в целом.** `state.failures` считает неудачные вызовы целиком,
и после `THINKER_ATTEMPT_BUDGET` (3) срабатывает второй триггер:

```
[delegate-io: N delegated calls have failed with different errors — …]
```

Второй триггер существует потому, что первый **слеп к главному случаю**:
если каждая попытка падает по-своему, `failuresByTool` на каждом новом сбое
сбрасывается в 1 и до порога не доходит — ровно так шла долгая отладка шторма
воркеров, где ни один инструмент не падал дважды подряд.

Счётчик `state.failures` обнуляется на каждом **успешном** делегированном
вызове, поэтому здоровая сессия его не накапливает.

> **Выключенный мыслитель называется явно.** Если `thinkEnabled: false`
> (дефолт), подсказка не исчезает, а меняет текст:
>
> ```
> [delegate-io: … — delegate_think would decide this, but the thinking worker
> is switched off (thinkEnabled). Turn it on in the plugin settings, or change
> approach instead of retrying the same step]
> ```
>
> Раньше подсказка всегда утверждала «delegate_think is available», даже когда
> инструмент был выключен: модель звали к инструменту, которого у неё нет.

Гейт **не решает**, что шаг нужен мыслителю: он только сообщает факт, которого
агент не видит из одного результата.

> `hintResult` вызывается и в ветке fallback (делегирование сорвалось, результат
> получен прямым вызовом), и в ветке **успешного** делегированного вызова — по
> второму триггеру агент должен узнать о несходимости независимо от того, чем
> закончился последний вызов. Ветка «задача выключена» уходит прямо в
> `real.execute` и счётчики не трогает.

---

## `delegate_inspect` — [`index.js:1680`](../index.js)

Отчёт воркера-читателя о пути вместо сырого содержимого. **Не замена `read`**:
для точного текста нужен `read`.

### Параметры

| Параметр | Тип | Обяз. | Смысл |
|---|---|---|---|
| `path` | string | да | Файл, каталог или URI |
| `focus` | string | да | Что отчёт должен ответить |
| `depth` | `overview` \| `normal` \| `thorough` | нет | Сколько дословных сниппетов (25/40/80 строк) |

### Ограничения вызова

- `inspectEnabled` выключено → ошибка;
- делегирование `read` выключено → `read delegation is switched off, so delegate_inspect cannot run`
  (использует пул `read`, то есть делит очередь с обычными `read`).

### Формат отчёта

`inspectPrompt` — [`index.js:701`](../index.js) — требует ровно эту форму:

```
found: <1–3 предложения по focus>
structure: <контур: файлы, секции, символы — с путём или строкой>
fragments: <до N строк "path:line <дословный текст из вывода инструмента>">
where to look next: <проверенные воркером пути>
confidence: <high|medium|low> · not checked: <что не прочитано>
```

Плюс ограничение длины и запрет «угадывать» содержимое.

### Почему отчёт без тулкола не принимается

`capture: 'answer'` ищет `usedTool === true`; иначе
`the file reader answered without calling a tool`. Отчёт, не опирающийся на
вызов инструмента, — это галлюцинация, и она отвергается на уровне механики,
а не доверия к промпту.

### Бюджет

`inspectMaxChars` (4000) применяется в `execute` через `budgetText` +
`saveSpill`. При недоступности спилла отчёт остаётся целым.

---

## `delegate_io_status` — [`index.js:1729`](../index.js)

Диагностика. Параметров нет, возвращает JSON.

### Полезная нагрузка

```jsonc
{
  "agents": [{
    "agent": "<id>",
    "mounted": ["read", "web_fetch", "web_search", "write", "edit"],
    // счётчики:
    "started": 0, "completed": 0, "fallbacks": 0,
    "truncated": 0, "summarized": 0, "summarizeFallbacks": 0,
    "inspected": 0,
    "verified": 0, "repaired": 0, "unverified": 0,
    "thought": 0, "thinkAsks": 0, "thinkFailed": 0,
    "escalated": 0,
    "compacted": 0, "compactionFailures": 0,
    "failures": 0,
    "recycled": 0, "recycleReasons": { "context limit spent (… >= …)": 0 },
    "lastError": null,
    "workers": [{ "task": "read", "childId": "…|null", "jobs": 0,
                  "lastJobAt": 0, "contextTokens": 0, "maxContextTokens": 0 }]
  }],
  "routes": { "read": { "enabled": true, "provider": "", "model": "", "reasoningEffort": "", "maxContextTokens": 0 } },
  "settings": { "count": 0, "ours": ["delegate-io"] },
  "subagentProvider": "spawn",
  "requestTimeoutMs": 900000,
  "fallbackToDirect": true,
  "maxResultChars": 12000,
  "verifyWrites": true,
  "budgetStrategy": "spill",
  "inspectEnabled": true,
  "inspectMaxChars": 4000,
  "depthBudget": "normal",
  "thinkMaxTurns": 2,
  "thinkEscalateAfter": 2,
  "tools": {
    "tools": {
      "delegate_think":   { "registered": true, "visible": true },
      "delegate_inspect": { "registered": true, "visible": true },
      "delegate_io_status": { "registered": true, "visible": true }
    },
    "summary": "every global tool is registered and visible to this agent"
  }
}
```

### `tools` — можно ли позвать инструмент

Модель **не видит свой список инструментов**, поэтому утверждение «этого
инструмента у меня нет» изнутри сессии непроверяемо. Раздел `tools` отвечает
на вопрос фактом, спрашивая реестр так же, как это делает исполнитель:
`registered` — зарегистрирован ли инструмент глобально (`tools.get(name)`),
`visible` — разрешает ли его scope вызывающего агента
(`tools.get(name, agent)`).

| `registered` | `visible` | Что значит |
|---|---|---|
| `false` | `false` | этот экземпляр плагина его не регистрировал — обычно в Host загружен старый модуль |
| `true` | `false` | зарегистрирован, но замаскирован для этого агента (`restrict`/пресет) |
| `true` | `true` | доступен |

`summary` — одна фраза: всё доступно либо перечень недостижимых имён.

### Как читать

- `routes.*.enabled` — **живые** значения, читаются на момент вызова.
- `tools.tools.<name>` — доступен ли инструмент вызывающему агенту **фактом**,
  а не по ощущению; см. выше.
- `settings.ours` — зарегистрирована ли страница настроек (если пусто —
  форма не подключилась).
- `workers[].childId === null` — слот пула ещё не запускал сессию.
- `workers[].slot` — индекс слота в пуле задачи (`read`/`web`/`write` — `0…2`,
  `think` — `0`). Воркеров в отчёте столько, сколько слотов в пуле, поэтому
  одна задача даёт несколько записей с одинаковым `task`.
- `fallbacks > 0` и `lastError` — делегирование ломается; смотреть `lastError`.
- `compactionFailures > 0` — компакция не работает; сессия при этом сохраняется.
- `recycled` / `recycleReasons` — сколько воркеров заменено и почему.
  Штатная причина одна — `context limit spent`; частые записи с ней означают,
  что лимит мал для этой работы. `root agent released` — просто закрытие
  агента или выгрузка плагина, это не замена. Любая другая причина в логе
  означает, что рецикл добавили в обход правила D15.
- `failures > 0` — счётчик неудачных вызовов воркера (сессия при этом
  остаётся живой). Рост `failures` без `recycled` — это, в том числе,
  незавершившиеся ходы: они видны в `lastError` и в `warn`-логе с пометкой
  «unsettled turn».

## Контракт «не мусорить в контекст»

Ни один из инструментов не возвращает внутренний транскрипт воркера. Только
отчёт/решение/телеметрию, каждый — в своём бюджете.

## На что легко сломать

- **Разрешить мыслителю инструменты** — цикл уточнений станет ненужным, а
  стоимость непредсказуемой.
- **Убрать `need`/`diagnosis` взаимоисключение** — расплывчатый ответ пройдёт
  как решение.
- **Снять `requireTool` с `delegate_inspect`** — отчёты начнут «подтверждаться»
  догадками.
- **Регистрировать инструменты не глобально**, а на агенте — пропадёт
  discoverability, но появится риск делегирования их самим воркерам.
