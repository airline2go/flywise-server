const mockSendEmail = jest.fn();
jest.mock('../src/services/email', () => ({
  sendEmail: (...args) => mockSendEmail(...args),
}));

jest.mock('../src/utils/log', () => jest.fn());

const express = require('express');
const request = require('supertest');

function buildApp() {
  const app = express();
  app.use(express.json());
  require('../src/routes/contact.routes')(app);
  return app;
}

const app = buildApp();

beforeEach(() => {
  mockSendEmail.mockReset();
});

describe('POST /contact', () => {
  test('requires name, email, and message', async () => {
    const res = await request(app).post('/contact').set('X-Forwarded-For', '10.0.0.1').send({ name: 'A' });
    expect(res.status).toBe(400);
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  test('rejects an invalid email address', async () => {
    const res = await request(app).post('/contact').set('X-Forwarded-For', '10.0.0.2').send({ name: 'A', email: 'not-an-email', message: 'hi' });
    expect(res.status).toBe(400);
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  test('sends the message and escapes HTML from user input', async () => {
    mockSendEmail.mockResolvedValue(true);
    const res = await request(app).post('/contact').set('X-Forwarded-For', '10.0.0.3').send({
      name: '<script>alert(1)</script>', email: 'a@b.com', subject: 'Hi', message: 'Hello & <b>world</b>',
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    const [to, subject, html] = mockSendEmail.mock.calls[0];
    expect(to).toBeTruthy();
    expect(subject).toBe('Kontaktformular: Hi');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('Hello &amp; &lt;b&gt;world&lt;/b&gt;');
  });

  test('defaults the subject when none is given', async () => {
    mockSendEmail.mockResolvedValue(true);
    await request(app).post('/contact').set('X-Forwarded-For', '10.0.0.4').send({ name: 'A', email: 'a@b.com', message: 'hi' });
    const [, subject] = mockSendEmail.mock.calls[0];
    expect(subject).toBe('Kontaktformular: Kontaktformular');
  });

  test('returns 502 when the email fails to send', async () => {
    mockSendEmail.mockResolvedValue(false);
    const res = await request(app).post('/contact').set('X-Forwarded-For', '10.0.0.5').send({ name: 'A', email: 'a@b.com', message: 'hi' });
    expect(res.status).toBe(502);
  });

  test('returns 500 when sendEmail throws', async () => {
    mockSendEmail.mockRejectedValue(new Error('brevo down'));
    const res = await request(app).post('/contact').set('X-Forwarded-For', '10.0.0.6').send({ name: 'A', email: 'a@b.com', message: 'hi' });
    expect(res.status).toBe(500);
  });
});
