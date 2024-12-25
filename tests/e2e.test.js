const longTimeout = 60000;

const isProd = process.env.NODE_ENV === 'production';
const url = isProd ? 'http://localhost:3000/dist/' : 'http://localhost:4000/';

const messages = [];

beforeAll(async () => {
  page.on('console', (msg) => messages.push({
    type: msg.type(),
    text: msg.text(),
    stack: msg.stackTrace(),
    location: msg.location(),
  }));
});

beforeEach(async () => {
  messages.length = 0;
  await page.goto('about:blank');
});

afterEach(async () => {
  // console.log('Messages:', JSON.stringify(messages, null, 2));
  console.log('Messages:', JSON.stringify(messages.map(({text}) => text), null, 2));
    
  const errors = messages.filter(msg =>
      msg.type === 'error' &&
      !(msg.text.includes('404')
          && msg.stack.some(s =>
              s.url.indexOf('fonts/InterVariable.woff') >= 0)));
  expect(errors).toHaveLength(0);
});

function loadSrc(src) {
  return page.goto(url + '#src:' + encodeURIComponent(src));
}
async function waitForViewer() {
  await page.waitForSelector('model-viewer');
  await page.waitForFunction(() => {
    const viewer = document.querySelector('model-viewer.main-viewer');
    return viewer && viewer.src !== '';
  });
}
function expectMessage(messages, line) {
  const successMessage = messages.filter(msg => msg.type === 'debug' && msg.text === line);
  expect(successMessage).toHaveLength(1);
}
function expectObjectList() {
  expectMessage(messages, 'stderr: Top level object is a list of objects:');
}
function expect3DPolySet() {
  expectMessage(messages, 'stderr: Top level object is a 3D object (PolySet):');
}
function expect3DManifold() {
  expectMessage(messages, 'stderr:    Top level object is a 3D object (manifold):');
}
function waitForCustomizeButton() {
  return page.waitForFunction(() => {
    const buttons = document.querySelectorAll('input[role=switch]');
    for (const button of buttons) {
      if (button.parentElement.innerText === 'Customize') {
        return button;
      }
    }
  });
}
function waitForLabel(text) {
  return page.waitForFunction((text) => {
    return Array.from(document.querySelectorAll('label')).find(el => el.textContent === 'myVar');
    // return Array.from(document.querySelectorAll('label')).find(el => el.textContent === text);
  }, {}, text);
}

describe('e2e', () => {
  test('load the default page', async () => {
    await page.goto(url);
    await waitForViewer();
    expectObjectList();
  }, longTimeout);

  test('can render cube', async () => {
    await loadSrc('cube([10, 10, 10]);');
    await waitForViewer();
    expect3DPolySet();
  }, longTimeout);
  
  test('use BOSL2', async () => {
    await loadSrc(`
      include <BOSL2/std.scad>;
      prismoid([40,40], [0,0], h=20);
    `);
    await waitForViewer();
    expect3DPolySet();
  }, longTimeout);

  test('use NopSCADlib', async () => {
    await loadSrc(`
      include <NopSCADlib/vitamins/led_meters.scad>
      meter(led_meter);
    `);
    await waitForViewer();
    expect3DManifold();
  }, longTimeout);

  test('customizer & windows line endings work', async () => {
    await loadSrc([
      'myVar = 10;',
      'cube(myVar);',
    ].join('\r\n'));
    await waitForViewer();
    expect3DPolySet();

    await (await waitForCustomizeButton()).click();

    await page.waitForSelector('fieldset');

    await waitForLabel('myVar');
  }, longTimeout);
});
