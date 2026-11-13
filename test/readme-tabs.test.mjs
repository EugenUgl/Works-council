/**
 * Регрессионный маркер: страница плагина — две вкладки, README встроен в
 * бандл, и `client.js` не требует ничего, кроме платформенных модулей.
 *
 * Почему этот тест существует — два разных бага в одном месте.
 *
 * 1. **Краш запуска DSH.** README лежал отдельным модулем `readme.js`, а
 *    `client.js` делал `require('./readme.js')`. Загрузчик web-бандла резолвит
 *    только `react`: на соседний файл он отказывает с
 *    `require("./readme.js") missed the module table`, и приложение не
 *    запускается целиком — один плагин уронил весь DSH (инцидент 2026-11-13,
 *    docs/decisions.md → D19). Этот тест ловил бы это до перезапуска: любое
 *    `require`, кроме платформенного, — поломка.
 * 2. **Разъехавшийся README.** Форма настроек и README раньше жили в одном
 *    полотне. После разделения на вкладки появился класс поломок, который в
 *    GUI ловится только вручную: вкладка README показывает встроенный текст,
 *    и у web-клиента нет способа прочитать файл пакета. Если блок забыть
 *    пересобрать, пользователь увидит устаревшую документацию, выданную за
 *    актуальную, — то «молчаливое» искажение, которое запрещено правилом №5
 *    в AGENTS.md (docs/decisions.md → D18).
 *
 * Поэтому тест проверяет три вещи:
 * 1. в `client.js` нет неплатформенных `require` (сторона загрузчика бандла);
 * 2. встроенный блок README совпадает с `README.md` (сторона генератора);
 * 3. `client.js` объявляет переключатель вкладок и панель README
 *    (сторона рендера — по коду, клиентского React-харнесса в проекте нет).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { currentSource } from '../scripts/build-readme.mjs';

const client = readFileSync(new URL('../client.js', import.meta.url), 'utf8');

/**
 * Вырезает из исходника текст, не являющийся исполняемым кодом: встроенный
 * блок README (там есть обратные кавычки и примеры) и комментарии `//`.
 *
 * Почему: поиск реальных `require(...)` по сырому тексту ловил бы примеры
 * поломок в комментариях и падал бы на собственной документации. Функцию
 * намеренно держим простой — этого достаточно для исходника, который
 * тест же и проверяет.
 *
 * @param {string} source содержимое client.js
 * @returns {string} исходник без блока README и без строчных комментариев
 */
function codeOnly(source) {
	return source
		.replace(/const README_MARKDOWN = `[\s\S]*?\n\s{4}`;/, 'const README_MARKDOWN = ``;')
		.replace(/\/\/[^\n]*/g, '');
}

/**
 * Все вызовы `require(...)` в коде файла.
 *
 * @param {string} source содержимое client.js
 * @returns {Array<{ match: RegExpExecArray, id: string }>} вызовы по порядку
 */
function codeCallsOf(source) {
	return [...codeOnly(source).matchAll(/\brequire\(\s*['"]([^'"]+)['"]\s*\)/g)].map((match) => ({
		match,
		id: match[1],
	}));
}

/**
 * Номер строки по индексу в исходнике — для внятного сообщения об отказе.
 *
 * @param {string} source содержимое файла
 * @param {number} index смещение
 * @returns {number} строка, начиная с единицы
 */
function lineOf(source, index) {
	return source.slice(0, index).split('\n').length;
}

// 1. Клиентский бандл самодостаточен. Список разрешённого — платформа:
// загрузчик бандла даёт плагину только её. Любое расширение списка должно
// быть осознанным решением, а не случайным импортом соседнего файла.
//
// Комментарии в тексте блока README — не код: там `require('./readme.js')`
// упомянут именно как пример поломки, игрушек-ловушек не устраиваем.
const platformModules = new Set(['react']);
for (const { match, id } of codeCallsOf(client)) {
	assert.ok(
		platformModules.has(id),
		`client.js:${lineOf(client, match.index)} require('${id}') не платформенный модуль — загрузчик бандла на нём откажет и уронит запуск DSH (D19)`,
	);
}

// 2. Встроенный текст README свежий.
assert.equal(
	client,
	await currentSource(),
	'блок README в client.js устарел: npm run build:readme (вкладка README показывала бы старый текст)',
);

// 3. Переключатель вкладок объявлен в клиенте.
for (const marker of [
	"useState('readme')",
	"role: 'tablist'",
	"role: 'tab'",
	'aria-selected',
	"setTab('settings')",
	"setTab('readme')",
	'tabReadme',
	'ReadmePanel',
	"role: 'tabpanel'",
]) {
	assert.ok(client.includes(marker), `client.js: не найден маркер вкладок ${marker}`);
}

// `summary` обязан быть пустым. Хост вызывает `plugins.row.config` ДВАЖДЫ на
// странице строки: `summary` — в строке описания, `page` — в секции
// конфигурации. Вкладки живут в `page`, поэтому любой текст в `summary`
// оказывается над ними, а если отдать туда ещё и разметку — получится второй
// переключатель вкладок под README (D22).
assert.ok(
	/if \(props\.view === 'summary'\) return null;/.test(client),
	'client.js: summary-вид должен быть пустым — иначе на странице строки появляется второй набор вкладок',
);
assert.ok(
	!/t\('summary'\)/.test(client),
	'client.js: t(\'summary\') снова рендерится — текст вернётся в строку описания хоста',
);

// README — первая вкладка. Проверяем по порядку объявления кнопок, а не по
// наличию маркеров: переставленные местами вкладки проходят проверку выше.
const tabBar = /role: 'tablist'[\s\S]*?\);\s*\n/.exec(client)?.[0] ?? '';
const readmeIndex = tabBar.indexOf('tabReadme');
const settingsIndex = tabBar.indexOf('tabSettings');
assert.ok(readmeIndex > 0 && settingsIndex > 0, 'client.js: в tablist должны быть обе вкладки');
assert.ok(
	readmeIndex < settingsIndex,
	'client.js: вкладка README должна стоять первой, а не после настроек',
);

// Панели не рисуют собственного заголовка и описания: над карточкой хост уже
// показал название и описание строки из locale/*.json. Второй заголовок —
// ровно то дублирование, из-за которого эта проверка и появилась.
for (const banned of ['title', 'help', 'readmeTitle', 'readmeNote']) {
	assert.ok(
		!client.includes(`t('${banned}')`),
		`client.js: t('${banned}') снова рендерится на странице — заголовок/описание дублирует хост`,
	);
}

// Гостовую шапку страницы (название + описание) рисует сам DSH из
// locale/*.json → meta, а не наш слот. Поэтому вернуть её можно только
// данными, и проверять надо данные. Почему это важно: `meta.description`
// идёт прямо над вкладками, и любое описание там — повтор того, что
// читатель находит в README первой же вкладкой (D20).
for (const name of ['en', 'ru']) {
	const locale = JSON.parse(readFileSync(new URL(`../locale/${name}.json`, import.meta.url), 'utf8'));
	assert.equal(
		locale.meta?.description,
		undefined,
		`locale/${name}.json: meta.description снова заполнен — над вкладками появится второй абзац описания`,
	);
	assert.ok(
		typeof locale.meta?.title === 'string' && locale.meta.title.trim() !== '',
		`locale/${name}.json: meta.title обязателен — хост отвергает пустую строку, а без него покажет имя пакета`,
	);
}

// `package.json`.`description` — не запасной вариант, а тот же дубль:
// при отсутствии meta.description хост подставляет его, и описание
// возвращается на страницу. Отсутствие файла — не то же самое, что пустое
// поле: пустая строка роняет чтение метаданных целиком (textOf), поэтому
// поле именно отсутствует.
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
assert.equal(
	manifest.description,
	undefined,
	'package.json: description вернётся на страницу плагина как подстановка вместо meta.description',
);

// 4. Сам встроенный текст: непустой, без разделов для разработчика и
// начинается с заголовка README.
const README_MARKDOWN = /const README_MARKDOWN = `\n([\s\S]*?)\n\s{4}`;/.exec(client)?.[1];
assert.ok(README_MARKDOWN !== undefined, 'client.js: не найден встроенный блок README_MARKDOWN');
assert.ok(README_MARKDOWN.length > 1000, 'встроенный README подозрительно короткий');
assert.ok(README_MARKDOWN.startsWith('# dsh-plugin-delegate-io'), 'текст должен начинаться с заголовка README');

// Вкладка README открыта первой и читается человеком, который настраивает
// плагин. Разделы про работу с репозиторием для него ложны (запускать тесты
// в GUI негде) и превращают справку в гору текста, которую не станут
// прокручивать. Проверяем каждый: генератор вырезает их по заголовку, и
// забытый раздел — это регрессия, видимая только глазами.
for (const heading of ['Правило проекта', 'Быстрый старт', 'Структура репозитория']) {
	assert.ok(
		!README_MARKDOWN.includes(heading),
		`вкладка README не должна содержать раздел для разработчика «${heading}» (scripts/build-readme.mjs)`,
	);
}

// Содержательные разделы должны остаться: если генератор срежет лишнее,
// вкладка опустеет, а тест на длину это пропустит.
for (const heading of ['Зачем это нужно', 'Что перехватывается', 'Известные ограничения']) {
	assert.ok(
		README_MARKDOWN.includes(heading),
		`вкладка README потеряла содержательный раздел «${heading}»`,
	);
}

console.log('readme-tabs: ok');
