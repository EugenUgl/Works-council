# Результаты и бюджет

> Предварительно: [`architecture.md`](architecture.md), [`workers.md`](workers.md)

## Задача

Результат инструмента может быть огромным (файл, страница). Отдавать его
основному агенту целиком — значит забивать контекст. Поэтому результат
**ограничивается бюджетом**, а полный текст **сохраняется** в spill-хранилище.

## Константы

| Имя | Значение | Где | Смысл |
|---|---|---|---|
| `BUDGET_HEAD_SHARE` | `0.6` | [`index.js:49`](../index.js) | доля бюджета под «голову», остальное — «хвост» |
| `SUMMARY_INPUT_MAX` | `80000` | [`index.js:63`](../index.js) | сколько символов отдаём воркеру для дайджеста |
| `maxResultChars` | `12000` | конфиг | бюджет результата инструмента |
| `inspectMaxChars` | `4000` | конфиг | бюджет отчёта `delegate_inspect` |

## `budgetText(text, limit, spill)` — [`index.js:293`](../index.js)

Чистая функция, покрыта `test/result.test.mjs`.

1. `headSize = floor(limit * 0.6)`, `tailSize = limit - headSize`.
2. Голова режется до ближайшего `\n`, если разрыв не дальше `headSize / 2`.
3. Хвост режется после ближайшего `\n`, если разрыв в первой половине `tailSize`.
4. Вставляется маркер:

```
… [delegate-io: N of M characters elided; the full result was saved (K bytes). <retrievalHint>]
```

Маркер **обязателен**: основной агент должен знать, что текст обрезан и где
лежит полная копия. `retrievalHint` приходит из `spillStore.saveText`.

## Спилл

`saveSpill` — [`index.js:544`](../index.js):

```js
spill.saveText({
  owner: { sessionId },
  source: { kind: 'tool', toolName, callId, label },
  suggestedName: `${toolName}-result.txt`,
  content: text,
});
```

`owner` — сессия **основного** агента, а не воркера: копию ищет пользователь и
основной агент. `callId` берётся из `exec`, с запасным значением по времени.

## `capResult` — [`index.js:573`](../index.js)

```
limit <= 0 || text.length <= limit        → text как есть
spillStore отсутствует / сохранить не удалось → warn + text как есть
иначе → state.truncated += 1; head = budgetText(...)
        budgetStrategy === 'summary' ? summarizeResult(...) : head
```

**Правило:** недоступность спилла не должна портить результат. Лучше отдать
целиком, чем отдать обрезанное без копии.

## Стратегия `spill` (по умолчанию)

Основной агент получает голову, хвост и маркер. Ноль дополнительных вызовов
модели — самый дешёвый и предсказуемый вариант.

## Стратегия `summary`

`summarizeResult` — [`index.js:610`](../index.js):

1. **Тот же слот** пула `read`, что и у обрезанного вызова, получает
   `summaryPrompt` — дайджест по **полному** тексту (обрезанному до
   `SUMMARY_INPUT_MAX`). Именно тот же слот, а не любой свободный: промпт
   ссылается на «твой предыдущий вызов», которого в чужой сессии не было.
2. Ответ заменяет содержимое, но **остаётся помечен**:

```
[delegate-io: digest of M characters; the full copy was saved (K bytes). <hint>]
```

3. Дайджест обрезается до `limit - prefix.length`; при обрезке добавляется
   `… [digest cut to the budget; the full copy was saved]`.
4. **Любая ошибка** второго прохода → `state.summarizeFallbacks += 1`,
   `warn` и возврат обычной головы/хвоста. Дайджест — оптимизация, не
   критический путь.

Стоимость: **один лишний проход модели** на каждый большой результат. Поэтому
по умолчанию выключено.

## Отчёт `delegate_inspect`

`delegate_inspect` использует свой бюджет (`inspectMaxChars`, по умолчанию
4000) и тот же `budgetText` + `saveSpill`. Отличается только метка источника
(`Delegated delegate_inspect result`) — см. [`tools.md`](tools.md).

## Телеметрия

`delegate_io_status` сообщает `truncated`, `summarized`, `summarizeFallbacks`,
`inspected`, `maxResultChars`, `budgetStrategy`, `inspectMaxChars`,
`depthBudget`. По ним видно, работает ли бюджет вообще.

## На что легко сломать

- **Убрать маркер** из `budgetText` — агент будет считать обрезанный текст
  целым и молча ошибаться.
- **Спиллить в сессию воркера** вместо основного агента — копия станет
  недостижимой после рецикла.
- **Сделать дайджест обязательным** — второй проход превращается в точку
  отказа.
- **Проверять бюджет до спилла** — потеряете копию в случае, если бюджета нет,
  а результат большой.
