# Верификация делегированной записи

> Предварительно: [`architecture.md`](architecture.md), [`previous: workers.md`](workers.md)

## Зачем

Воркер — модель. Она может «улучшить» содержимое файла, укоротить строку,
переотформатировать JSON. Для `read` это раздражает, для `write`/`edit` —
**разрушает файл**. Поэтому делегированная мутация проверяется по файлу на
диске, а расхождение исправляется.

## Константы и флаг

| Имя | Значение | Где |
|---|---|---|
| `VERIFY_MAX_BYTES` | `2_000_000` | [`index.js:42`](../index.js) — больше этого файл не снимкается и не проверяется |
| `verifyWrites` | `true` | конфиг — выключатель всей подсистемы |

## Шаг 1 — снимок до

`prepareVerification(state, toolName, args, signal)` — [`index.js:477`](../index.js):

| Условие | Результат |
|---|---|
| `verifyWrites()` выключено | `undefined` |
| инструмент не `write`/`edit` | `undefined` |
| `args.file_path` не строка | `undefined` |
| `write` | `{ before: undefined }` — содержимое предсказуемо из аргументов |
| `edit` | читает файл; `{ before }` только если это строка |

Любая невозможность наблюдать файл даёт `undefined` — вызов **останется
непроверенным**, но не упадёт.

## Шаг 2 — предсказание

`expectedContentOf(toolName, args, before)` — [`index.js:259`](../index.js), чистая
функция, покрыта `test/result.test.mjs`.

- `write` → `args.content` (если строка);
- `edit` → требует строковые `old_string` и `new_string`, непустой `old_string`
  и строковый `before`; ищет **первое** вхождение:
  - `replace_all === true` → `before.split(old).join(new)`;
  - иначе → `before.slice(0, i) + new_string + before.slice(i + old.length)`;
- иначе `undefined` (непредсказуемо → не проверяем).

## Шаг 3 — сверка и ремонт

`settleVerification` — [`index.js:496`](../index.js):

```
plan === undefined || failed === true        → ничего (воркер уже упал)
expected === undefined                        → state.unverified += 1
actual === undefined (файл не наблюдаем)      → state.unverified += 1
sameFileText(actual, expected)                → state.verified += 1
иначе:
  reparation = (toolName === 'edit') ? state.tools.get('write') : real
  репарации нет → throw error.delegateIoVerification = true
  repair.execute(...) → state.repaired += 1 → warn + текст о починке
```

### Сравнение

`sameFileText` — [`index.js:279`](../index.js) — сравнивает с поправкой на
переводы строк (CRLF → LF). Бэкенд вправе переписать окончания строк; это не
расхождение.

### Почему ремонт делает `write`, а не `edit`

Повторный `edit` применил бы правку второй раз. Поэтому для `edit` ремонт —
это `write` с **предсказанным** содержимым (`{ file_path, content: expected }`).
Для `write` ремонт — тот же инструмент с теми же аргументами.

## Шаг 4 — сообщение агенту

При ремонте возвращается текст вместо текста воркера:

```
delegate-io: the delegated <tool> did not match the requested content
(chars/`no file on disk` … instead of N); the file was rewritten with the expected content.
```

Так основной агент видит не «OK», а факт починки — и может перепроверить.

## Флаг `delegateIoVerification`

Если ремонт невозможен, бросается ошибка с `error.delegateIoVerification = true`.
Клон **перебрасывает** её, не уходя в `fallbackToDirect`:

```js
if (error?.delegateIoVerification === true) throw error;
```

Причина: файл уже приведён к ожидаемому состоянию; повторный прогон `edit`
удвоил бы правку.

## Что входит в телеметрию

`verified`, `repaired`, `unverified` в `delegate_io_status`.

`unverified` — **не ошибка**, а «не смогли проверить» (бинарный файл, файл
слишком большой, нет `fs`, непредсказуемые аргументы).

## Ограничения (осознанные)

1. Файлы > 2 МБ не проверяются.
2. `edit` не различает «одно вхождение» и «несколько вхождений при выключенном
   `replace_all`»: в обоих случаях предсказывается правка первого вхождения.
   Если настоящий `edit` такой аргумент отвергнет, воркер вернёт ошибку,
   `failed === true`, и сверки не будет.
3. Отсутствие файла при `write` не отличается от «файл на месте, но не читается» —
   оба случая идут по ветке `undefined`/`null`.
4. Снимок делается **до** постановки в очередь? Нет: внутри `runJob`, то есть
   после ожидания очереди. Значит, между снимком и запуском воркера файл мог
   измениться другим вызовом — сверка увидит расхождение и «починит» файл.
   Это консервативно и безопасно для консистентности, но может откатить
   чужую правку. В обычной сессии конфликт маловероятен.

## На что легко сломать

- **Проверять `edit` без `before`** — предсказание станет неверным.
- **Чинить `edit` повторным `edit`** — двойная правка (см. выше).
- **Убрать `delegateIoVerification` из переброса** — повторный `edit` в fallback.
- **Сравнивать строго без CRLF-нормализации** — ложные «расхождения» на Windows.
- **Делать снимок в клоне до `dispatch`** — конфликт с очередью при параллельных
  вызовах и лишнее чтение при отключённой задаче.
