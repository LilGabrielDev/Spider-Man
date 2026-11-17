import axios from 'axios';
import config from '../../spider/config.js';
import { extractContextInfo } from '../../spider/utils/groupActionHelper.js';
import {
  spiderHeader,
  spiderRow,
  spiderDivider,
  spiderFooter,
} from '../utils/tableStyle.js';

const botName = () => config.BOT_NAME || 'Spider Man';

const EIGHT_BALL_ANSWERS = [
  '✅ It is certain.',
  '✅ Without a doubt.',
  '✅ Yes, definitely.',
  '✅ Most likely.',
  '✅ Signs point to yes.',
  '🔮 Ask again later.',
  '🔮 Cannot predict now.',
  '🔮 Concentrate and ask again.',
  "❌ Don't count on it.",
  '❌ My reply is no.',
  '❌ My sources say no.',
  '❌ Very doubtful.',
  '❌ Outlook not so good.',
];

const TRUTHS = [
  'What is your biggest fear?',
  "What is the most embarrassing thing you've done?",
  'What is your biggest secret?',
  'Have you ever lied to your best friend?',
  "What is the worst gift you've received?",
  "What is something you've never told anyone?",
  'What is the most childish thing you still do?',
  'Have you ever cheated on a test?',
  'What is your biggest regret?',
  "What is the weirdest dream you've had?",
  'What is a habit you are secretly trying to break?',
  'Who was your first crush?',
];

const DARES = [
  'Send a voice note singing your favorite chorus.',
  'Change your status to a funny quote for 1 hour.',
  'Do 20 push-ups right now.',
  'Send the 5th emoji in your recent list and explain it.',
  'Speak only in questions for the next 5 messages.',
  'Compliment 3 people in this chat genuinely.',
  'Write a 4-line poem about the person who dared you.',
  'Share the last photo you took (safe for work!).',
  'Tell everyone your funniest childhood story.',
  'Type your next message with your eyes closed.',
];

const RIDDLES = [
  { q: 'I speak without a mouth and hear without ears. I have no body, but I come alive with wind. What am I?', a: 'An echo' },
  { q: 'The more you take, the more you leave behind. What am I?', a: 'Footsteps' },
  { q: 'I have cities, but no houses. I have mountains, but no trees. I have water, but no fish. What am I?', a: 'A map' },
  { q: "What has hands but can't clap?", a: 'A clock' },
  { q: 'What gets wetter the more it dries?', a: 'A towel' },
  { q: 'What has to be broken before you can use it?', a: 'An egg' },
  { q: 'What goes up but never comes down?', a: 'Your age' },
  { q: 'What can you catch but not throw?', a: 'A cold' },
  { q: 'The more of it there is, the less you see. What is it?', a: 'Darkness' },
  { q: 'What has one eye but cannot see?', a: 'A needle' },
  { q: "I'm full of holes but still hold water. What am I?", a: 'A sponge' },
];

const ROASTS = [
  "You're the human equivalent of a participation trophy.",
  "I'd explain it to you, but I don't have crayons.",
  "You're like a cloud. When you disappear, it's a beautiful day.",
  "I'd agree with you, but then we'd both be wrong.",
  'Your secrets are safe with me. I never even listen when you talk.',
  "You're like a software update — whenever I see you, I think 'not now.'",
  'If you were any slower, you would be going backwards.',
  "You're proof that WiFi works even at 1% brain battery.",
];

const COMPLIMENTS = [
  'Your presence makes every room brighter. ✨',
  'People are lucky to have you in their lives. 🍀',
  'Your sense of humor brings so much joy to others. 😄',
  'You have a heart of gold. 💛',
  "You're doing better than you think. Keep going!",
  'Your intelligence and thoughtfulness are truly remarkable.',
  'You make hard things look easy — that is a real talent.',
  'Being around you feels like a breath of fresh air. 🌬️',
  'You bring out the best in the people around you. 🌸',
  'Your dedication and work ethic are truly admirable. 🏆',
];

const WYR_OPTIONS = [
  ['Be able to fly', 'Be able to turn invisible'],
  ['Live without music', 'Live without movies'],
  ['Always be 10 minutes late', 'Always be 20 minutes early'],
  ['Have unlimited money', 'Have unlimited knowledge'],
  ['Explore the deep ocean', 'Explore outer space'],
  ['Control fire', 'Control water'],
  ['Read minds', 'See 10 minutes into the future'],
  ['Speak all languages fluently', 'Play every musical instrument'],
  ['Travel to the past', 'Travel to the future'],
  ['Have no phone for a month', 'Have no laptop for a month'],
];

const NHIE_ITEMS = [
  'Never have I ever lied to get out of plans.',
  'Never have I ever pretended to text to avoid talking to someone.',
  'Never have I ever stayed up all night watching a series.',
  'Never have I ever laughed so hard I cried.',
  'Never have I ever talked to myself out loud.',
  'Never have I ever forgotten what I walked into a room for.',
  'Never have I ever waved back at someone waving behind me.',
  'Never have I ever dropped my phone on my own face.',
  'Never have I ever re-gifted a present.',
  'Never have I ever eaten food after the 5-second rule.',
];

const TOT_OPTIONS = [
  ['Pizza', 'Burger'],
  ['Morning', 'Night'],
  ['Beach', 'Mountains'],
  ['Coffee', 'Tea'],
  ['Summer', 'Winter'],
  ['Android', 'iPhone'],
  ['Books', 'Movies'],
  ['Call', 'Text'],
  ['Cats', 'Dogs'],
  ['Sweet', 'Savory'],
];

const FORTUNES = [
  'A pleasant surprise is waiting for you around the corner.',
  'Your creativity will lead you to great success.',
  'Your hard work is about to pay off in ways you did not expect.',
  'An exciting new opportunity lies ahead.',
  'Good things come to those who stay consistent.',
  'You will receive unexpected good news soon.',
  'Your ability to adapt will take you very far.',
  'Today is a good day to start something bold.',
];

const PICKUP_LINES = [
  'Are you Wi-Fi? Because I feel a strong connection.',
  'Do you have a map? I just got lost in your eyes.',
  'Are you made of copper and tellurium? Because you are Cu-Te.',
  'Is your name Google? Because you have everything I have been searching for.',
  'If beauty were time, you would be an eternity.',
  'Are you a charger? Because my battery was dead until you showed up.',
  'Did it hurt when you fell from heaven?',
  'Do you believe in love at first text, or should I message you again?',
];

const PROVERBS = [
  { text: 'A journey of a thousand miles begins with a single step.', origin: 'Lao Tzu' },
  { text: 'Slow and steady wins the race.', origin: 'Aesop' },
  { text: 'It takes a village to raise a child.', origin: 'African Proverb' },
  { text: 'Well begun is half done.', origin: 'Aristotle' },
  { text: 'Patience is a virtue.', origin: 'Traditional' },
  { text: 'Two heads are better than one.', origin: 'English Proverb' },
  { text: 'The darkest hour is just before the dawn.', origin: 'English Proverb' },
  { text: 'With great power comes great responsibility.', origin: 'Classic Maxim' },
  { text: 'Smooth seas do not make skillful sailors.', origin: 'African Proverb' },
  { text: 'Knowledge is a garden; if it is not cultivated, it cannot be harvested.', origin: 'Guinean Proverb' },
];

const NUMBER_FACTS = {
  0: '0 is the only number that is neither positive nor negative.',
  1: '1 is the only positive integer that is neither prime nor composite.',
  2: '2 is the only even prime number.',
  3: '3 is the first odd prime number and the number of dimensions we move in.',
  7: '7 is considered the most popular lucky number worldwide.',
  13: '13 is an unlucky number in some cultures, yet a baker’s dozen celebrates it.',
  42: '42 is the "Answer to the Ultimate Question of Life" in The Hitchhiker’s Guide to the Galaxy.',
  100: '100 is the sum of the first nine prime numbers (2+3+5+7+11+13+17+19+23).',
  365: '365 is the number of days in a common Earth year.',
  1000: '1000 is a millennium when measuring years.',
};

const ZODIAC_SIGNS = [
  'aries', 'taurus', 'gemini', 'cancer', 'leo', 'virgo',
  'libra', 'scorpio', 'sagittarius', 'capricorn', 'aquarius', 'pisces',
];

const ZODIAC_EMOJIS = {
  aries: '♈', taurus: '♉', gemini: '♊', cancer: '♋',
  leo: '♌', virgo: '♍', libra: '♎', scorpio: '♏',
  sagittarius: '♐', capricorn: '♑', aquarius: '♒', pisces: '♓',
};

const HOROSCOPE_FALLBACKS = [
  'Focus your energy on one meaningful goal today — steady momentum beats rushing.',
  'An unexpected conversation brings clarity to a decision you have been weighing.',
  'Take time to recharge and trust your instincts when new opportunities arise.',
  'Collaboration works in your favor today; listen closely to someone you trust.',
];

const ANIMAL_FACTS = [
  'A group of owls is called a parliament.',
  'Dolphins sleep with one eye open.',
  'Elephants are the only mammals that cannot jump.',
  'Octopuses have three hearts and blue blood.',
  'Hummingbirds are the only birds capable of flying backwards.',
  'Koalas sleep up to 22 hours a day.',
  'Sharks have existed longer than trees.',
  'Cows form close friendships and get stressed when separated.',
];

const SPACE_FACTS = [
  'A day on Venus is longer than a year on Venus.',
  'Neutron stars can spin up to 600 times per second.',
  'Space is completely silent because there is no air to carry sound.',
  'One million Earths could fit inside the Sun.',
  'Mars sunsets appear blue to the human eye.',
  'Saturn would float in water if you had a big enough ocean.',
  'The International Space Station orbits Earth at roughly 28,000 km/h.',
];

const SCIENCE_FACTS = [
  'Honey never spoils — edible jars thousands of years old have been found in tombs.',
  'Bananas are naturally slightly radioactive due to potassium-40.',
  'Lightning strikes Earth roughly 100 times every second.',
  'Water can boil and freeze at the exact same time at its triple point.',
  'The human body contains around 37 trillion cells.',
  'Hot water can sometimes freeze faster than cold water (the Mpemba effect).',
];

const HISTORY_FACTS = [
  'Cleopatra lived closer in time to the Moon landing than to the building of the Great Pyramid.',
  'Oxford University is older than the Aztec Empire.',
  'The shortest recorded war in history lasted under 45 minutes.',
  'Ada Lovelace wrote the first published computer algorithm in the 1840s.',
  'Ancient Romans used volcanic ash in concrete that still endures underwater today.',
];

const TECH_FACTS = [
  'The first computer bug was an actual moth found in a Harvard Mark II relay in 1947.',
  'The HTTP 418 status code officially stands for "I\'m a teapot".',
  'The first 1GB hard drive (IBM 3380, 1980) weighed over 250 kg.',
  'Over 90% of the world’s servers run on Linux-based operating systems.',
  'The "@" symbol in emails was chosen by Ray Tomlinson in 1971.',
];

const EXCUSES = [
  'My alarm went off in a parallel universe instead of this one.',
  'I got caught in an unexpectedly intense staring contest with my cat.',
  'My Wi-Fi decided to take a mental health day.',
  'Time zones betrayed me personally.',
  'I accidentally put my phone on airplane mode and it flew away.',
  'I was waiting for a software update to reach 100% (it stayed at 99% for an hour).',
];

const AFFIRMATIONS = [
  'I am capable of achieving the goals I set for myself.',
  'Every small step forward builds lasting momentum.',
  'I choose clarity, patience, and confidence today.',
  'I am growing stronger and wiser with every experience.',
  'I attract positive energy and meaningful opportunities.',
];

const CHALLENGES = [
  'Drink 8 full glasses of water today. 💧',
  'Read 20 pages of a book before bed. 📖',
  'Go for a 30-minute walk with no headphones. 👣',
  'Send a genuine thank-you message to someone who helped you. 💬',
  'Write down 3 wins from this week. 📝',
  'Take a 2-hour break from scrolling social media. 📵',
];

const DREAMS = {
  flying: { meaning: 'Freedom, ambition, and a desire to rise above limits.', tip: 'Trust your momentum on a project or goal.' },
  falling: { meaning: 'Feeling overwhelmed or lacking control in some area.', tip: 'Identify one stressful commitment you can simplify.' },
  water: { meaning: 'Emotions, reflection, and renewal.', tip: 'Calm water signals clarity; turbulent water hints at unaddressed feelings.' },
  teeth: { meaning: 'Anxiety around appearance, confidence, or communication.', tip: 'Speak clearly about something you have held back.' },
  chase: { meaning: 'Avoiding a difficult decision or responsibility.', tip: 'Face one lingering task head-on today.' },
  snake: { meaning: 'Hidden tension, change, or personal transformation.', tip: 'Stay observant of shifting dynamics around you.' },
  exam: { meaning: 'Self-evaluation or fear of not measuring up.', tip: 'Give yourself credit for how prepared you already are.' },
};

const pendingRiddles = new Map();
const numberGuesses = new Map();

function pickRandom(list) {
  return list[Math.floor(Math.random() * list.length)];
}

function isPrime(n) {
  if (n < 2) return false;
  if (n === 2) return true;
  if (n % 2 === 0) return false;
  for (let i = 3; i <= Math.sqrt(n); i += 2) {
    if (n % i === 0) return false;
  }
  return true;
}

function getMentioned(msg) {
  const ctx = extractContextInfo(msg);
  return ctx?.mentionedJid || [];
}

function card(title, rows, footer = `${botName()} // FUN`) {
  return [
    spiderHeader(botName(), title),
    ...rows,
    spiderFooter(footer),
  ].join('\n');
}

export const commands = [
  {
    name: '8ball',
    aliases: ['magic8', 'eightball'],
    description: 'Ask the magic 8-ball a yes/no question.',
    category: 'Fun',
    execute: async ({ sock, from, msg, text }) => {
      const question = String(text || '').trim();
      if (!question) {
        return sock.sendMessage(
          from,
          { text: '🎱 *Magic 8-Ball*\nUsage: `.8ball <question>`\nExample: `.8ball Will today be great?`' },
          { quoted: msg },
        );
      }
      const reply = card('MAGIC 8-BALL', [
        spiderRow('QUESTION', question, '❓'),
        spiderRow('ANSWER', pickRandom(EIGHT_BALL_ANSWERS), '🎱'),
      ]);
      return sock.sendMessage(from, { text: reply }, { quoted: msg });
    },
  },
  {
    name: 'truth',
    aliases: ['truthq'],
    description: 'Get a random Truth question.',
    category: 'Fun',
    execute: async ({ sock, from, msg }) => {
      const reply = card('TRUTH CHALLENGE', [
        spiderRow('PROMPT', pickRandom(TRUTHS), '🔍'),
        spiderDivider('BE HONEST'),
      ]);
      return sock.sendMessage(from, { text: reply }, { quoted: msg });
    },
  },
  {
    name: 'dare',
    aliases: ['dareq'],
    description: 'Get a random Dare challenge.',
    category: 'Fun',
    execute: async ({ sock, from, msg }) => {
      const reply = card('DARE CHALLENGE', [
        spiderRow('CHALLENGE', pickRandom(DARES), '🎯'),
        spiderDivider('NO BACKING OUT'),
      ]);
      return sock.sendMessage(from, { text: reply }, { quoted: msg });
    },
  },
  {
    name: 'tod',
    aliases: ['truthordare'],
    description: 'Randomly pick Truth or Dare.',
    category: 'Fun',
    execute: async ({ sock, from, msg }) => {
      const isTruth = Math.random() < 0.5;
      const reply = card('TRUTH OR DARE', [
        spiderRow('MODE', isTruth ? 'TRUTH 🔍' : 'DARE 🎯', '🎲'),
        spiderRow('PROMPT', isTruth ? pickRandom(TRUTHS) : pickRandom(DARES), '◈'),
      ]);
      return sock.sendMessage(from, { text: reply }, { quoted: msg });
    },
  },
  {
    name: 'riddle',
    aliases: [],
    description: 'Get a riddle — use .answer to check or reveal it.',
    category: 'Fun',
    execute: async ({ sock, from, msg }) => {
      let pick = null;
      try {
        const res = await axios.get('https://riddles-api.vercel.app/random', { timeout: 6000 });
        if (res.data?.riddle && res.data?.answer) {
          pick = { q: res.data.riddle, a: res.data.answer };
        }
      } catch {}
      if (!pick) pick = pickRandom(RIDDLES);

      pendingRiddles.set(from, pick);
      const timer = setTimeout(() => pendingRiddles.delete(from), 5 * 60 * 1000);
      timer?.unref?.();

      const reply = card('RIDDLE TIME', [
        spiderRow('QUESTION', pick.q, '🧩'),
        spiderRow('TIP', 'Use `.answer <guess>` or `.answer` to reveal', '💡'),
      ]);
      return sock.sendMessage(from, { text: reply }, { quoted: msg });
    },
  },
  {
    name: 'answer',
    aliases: ['ans'],
    description: 'Check or reveal the answer to the active riddle.',
    category: 'Fun',
    execute: async ({ sock, from, msg, text }) => {
      const active = pendingRiddles.get(from);
      if (!active) {
        return sock.sendMessage(
          from,
          { text: '❓ No active riddle in this chat. Start one with `.riddle`!' },
          { quoted: msg },
        );
      }
      const guess = String(text || '').trim();
      pendingRiddles.delete(from);

      if (guess) {
        const normGuess = guess.toLowerCase();
        const normAnswer = active.a.toLowerCase();
        const matched = normAnswer.includes(normGuess) || normGuess.includes(normAnswer.replace(/^(an?|the)\s+/i, ''));
        return sock.sendMessage(
          from,
          {
            text: card('RIDDLE RESULT', [
              spiderRow('YOUR GUESS', guess, '📝'),
              spiderRow('STATUS', matched ? '✅ Correct!' : '❌ Not quite!', '🏁'),
              spiderRow('ANSWER', active.a, '💡'),
            ]),
          },
          { quoted: msg },
        );
      }

      return sock.sendMessage(
        from,
        {
          text: card('RIDDLE ANSWER', [
            spiderRow('ANSWER', active.a, '✅'),
          ]),
        },
        { quoted: msg },
      );
    },
  },
  {
    name: 'roast',
    aliases: ['roastme'],
    description: 'Send a lighthearted roast.',
    category: 'Fun',
    execute: async ({ sock, from, msg, args }) => {
      const mentions = getMentioned(msg);
      const target = mentions[0]
        ? `@${mentions[0].split('@')[0]}`
        : (args[0] || 'you');
      const reply = card('FRIENDLY ROAST', [
        spiderRow('TARGET', target, '🔥'),
        spiderRow('LINE', pickRandom(ROASTS), '💬'),
      ]);
      return sock.sendMessage(from, { text: reply, mentions: mentions.slice(0, 1) }, { quoted: msg });
    },
  },
  {
    name: 'compliment',
    aliases: ['comp', 'praise'],
    description: 'Send a kind compliment to someone.',
    category: 'Fun',
    execute: async ({ sock, from, msg, args }) => {
      const mentions = getMentioned(msg);
      const target = mentions[0]
        ? `@${mentions[0].split('@')[0]}`
        : (args[0] || '');
      const line = pickRandom(COMPLIMENTS);
      const reply = card('COMPLIMENT', [
        ...(target ? [spiderRow('FOR', target, '💐')] : []),
        spiderRow('MESSAGE', line, '✨'),
      ]);
      return sock.sendMessage(from, { text: reply, mentions: mentions.slice(0, 1) }, { quoted: msg });
    },
  },
  {
    name: 'ship',
    aliases: ['couple', 'lovematch'],
    description: 'Calculate compatibility percentage between two people.',
    category: 'Fun',
    execute: async ({ sock, from, msg, text }) => {
      const mentions = getMentioned(msg);
      const raw = String(text || '').trim();
      const parts = raw.split(/\s+and\s+|\s*,\s*|\s*&\s*|\s*\+\s*/i).filter(Boolean);
      let p1 = parts[0];
      let p2 = parts[1];

      if (mentions.length >= 2) {
        p1 = `@${mentions[0].split('@')[0]}`;
        p2 = `@${mentions[1].split('@')[0]}`;
      } else if (!p1 || !p2) {
        return sock.sendMessage(
          from,
          { text: '💕 Usage: `.ship <name1> and <name2>` or mention two people!' },
          { quoted: msg },
        );
      }

      const seed = `${p1}${p2}`.toLowerCase().split('').reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
      const pct = seed % 101;
      const filled = Math.floor(pct / 10);
      const bar = '💗'.repeat(filled) + '🖤'.repeat(10 - filled);
      const verdict = pct >= 80
        ? '💍 Perfect match!'
        : pct >= 60
          ? '💕 Great chemistry!'
          : pct >= 40
            ? '😊 Solid potential!'
            : pct >= 20
              ? '🤔 Needs a little effort.'
              : '💔 Better as friends.';

      const reply = card('SHIP METER', [
        spiderRow('PAIR', `${p1} + ${p2}`, '👫'),
        spiderRow('SCORE', `${pct}% ${bar}`, '❤️'),
        spiderRow('VERDICT', verdict, '✨'),
      ]);
      return sock.sendMessage(from, { text: reply, mentions }, { quoted: msg });
    },
  },
  {
    name: 'dice',
    aliases: ['rolldice'],
    description: 'Roll one or more 6-sided dice.',
    category: 'Fun',
    execute: async ({ sock, from, msg, args }) => {
      const count = Math.min(Math.max(parseInt(args[0], 10) || 1, 1), 10);
      const rolls = Array.from({ length: count }, () => Math.floor(Math.random() * 6) + 1);
      const total = rolls.reduce((a, b) => a + b, 0);
      const reply = card('DICE ROLL', [
        spiderRow('DICE', `${count} × d6`, '🎲'),
        spiderRow('ROLLED', rolls.join(' · '), '🎯'),
        ...(count > 1 ? [spiderRow('TOTAL', String(total), '∑')] : []),
      ]);
      return sock.sendMessage(from, { text: reply }, { quoted: msg });
    },
  },
  {
    name: 'rps',
    aliases: ['rockpaperscissors'],
    description: 'Play Rock Paper Scissors against the bot.',
    category: 'Fun',
    execute: async ({ sock, from, msg, args }) => {
      const choices = ['rock', 'paper', 'scissors'];
      const icons = { rock: '🪨', paper: '📄', scissors: '✂️' };
      const pick = String(args[0] || '').toLowerCase();
      if (!choices.includes(pick)) {
        return sock.sendMessage(
          from,
          { text: '🪨📄✂️ Usage: `.rps <rock|paper|scissors>`' },
          { quoted: msg },
        );
      }
      const botPick = pickRandom(choices);
      let outcome = "It's a tie! 🤝";
      if (
        (pick === 'rock' && botPick === 'scissors') ||
        (pick === 'paper' && botPick === 'rock') ||
        (pick === 'scissors' && botPick === 'paper')
      ) {
        outcome = 'You win! 🎉';
      } else if (pick !== botPick) {
        outcome = 'Spider Man wins! 😎';
      }

      const reply = card('ROCK PAPER SCISSORS', [
        spiderRow('YOU', `${icons[pick]} ${pick}`, '👤'),
        spiderRow('BOT', `${icons[botPick]} ${botPick}`, '🤖'),
        spiderRow('RESULT', outcome, '🏆'),
      ]);
      return sock.sendMessage(from, { text: reply }, { quoted: msg });
    },
  },
  {
    name: 'guess',
    aliases: ['guessnum', 'numguess'],
    description: 'Play a 1–100 number guessing game.',
    category: 'Fun',
    execute: async ({ sock, from, msg, args }) => {
      if (!args.length) {
        const target = Math.floor(Math.random() * 100) + 1;
        numberGuesses.set(from, { target, tries: 0 });
        return sock.sendMessage(
          from,
          { text: '🎯 *Number Guessing Game*\nI picked a number between *1* and *100*.\nGuess with `.guess <number>`!' },
          { quoted: msg },
        );
      }
      const n = parseInt(args[0], 10);
      if (Number.isNaN(n)) {
        return sock.sendMessage(from, { text: '❌ Please enter a valid number: `.guess 42`' }, { quoted: msg });
      }
      let game = numberGuesses.get(from);
      if (!game) {
        game = { target: Math.floor(Math.random() * 100) + 1, tries: 0 };
        numberGuesses.set(from, game);
      }
      game.tries += 1;
      if (n === game.target) {
        numberGuesses.delete(from);
        return sock.sendMessage(
          from,
          { text: `🎉 *Correct!* The number was *${game.target}* (solved in ${game.tries} tries).` },
          { quoted: msg },
        );
      }
      return sock.sendMessage(
        from,
        { text: n < game.target ? `⬆️ *${n}* is too low! Try higher.` : `⬇️ *${n}* is too high! Try lower.` },
        { quoted: msg },
      );
    },
  },
  {
    name: 'slot',
    aliases: ['slots', 'slotmachine'],
    description: 'Spin the slot machine.',
    category: 'Fun',
    execute: async ({ sock, from, msg }) => {
      const reels = ['🍒', '🍋', '🍊', '🍇', '⭐', '💎', '7️⃣'];
      const a = pickRandom(reels);
      const b = pickRandom(reels);
      const c = pickRandom(reels);
      const status = a === b && b === c
        ? '🎉 JACKPOT! Three of a kind!'
        : (a === b || b === c || a === c)
          ? '😊 Two match! So close!'
          : '😢 No match — spin again!';
      const reply = card('SLOT MACHINE', [
        spiderRow('REELS', `[ ${a} | ${b} | ${c} ]`, '🎰'),
        spiderRow('OUTCOME', status, '🏆'),
      ]);
      return sock.sendMessage(from, { text: reply }, { quoted: msg });
    },
  },
  {
    name: 'wouldyourather',
    aliases: ['wyr'],
    description: 'Get a Would You Rather dilemma.',
    category: 'Fun',
    execute: async ({ sock, from, msg }) => {
      const [optA, optB] = pickRandom(WYR_OPTIONS);
      const reply = card('WOULD YOU RATHER', [
        spiderRow('OPTION A', optA, '🅰️'),
        spiderRow('OPTION B', optB, '🅱️'),
      ]);
      return sock.sendMessage(from, { text: reply }, { quoted: msg });
    },
  },
  {
    name: 'neverhaveiever',
    aliases: ['nhie'],
    description: 'Play Never Have I Ever.',
    category: 'Fun',
    execute: async ({ sock, from, msg }) => {
      const reply = card('NEVER HAVE I EVER', [
        spiderRow('PROMPT', pickRandom(NHIE_ITEMS), '🙅'),
        spiderRow('REACT', '👍 if you have · 👎 if you haven’t', '◈'),
      ]);
      return sock.sendMessage(from, { text: reply }, { quoted: msg });
    },
  },
  {
    name: 'thisorthat',
    aliases: ['tot'],
    description: 'Quick This or That preference prompt.',
    category: 'Fun',
    execute: async ({ sock, from, msg }) => {
      const [x, y] = pickRandom(TOT_OPTIONS);
      const reply = card('THIS OR THAT', [
        spiderRow('CHOICE A', x, '🅰️'),
        spiderRow('CHOICE B', y, '🅱️'),
      ]);
      return sock.sendMessage(from, { text: reply }, { quoted: msg });
    },
  },
  {
    name: 'fortune',
    aliases: ['fortunecookie'],
    description: 'Crack open a fortune cookie.',
    category: 'Fun',
    execute: async ({ sock, from, msg }) => {
      const reply = card('FORTUNE COOKIE', [
        spiderRow('FORTUNE', pickRandom(FORTUNES), '🥠'),
      ]);
      return sock.sendMessage(from, { text: reply }, { quoted: msg });
    },
  },
  {
    name: 'pickupline',
    aliases: ['pickup', 'rizz'],
    description: 'Get a smooth pickup line.',
    category: 'Fun',
    execute: async ({ sock, from, msg }) => {
      const reply = card('PICKUP LINE', [
        spiderRow('LINE', pickRandom(PICKUP_LINES), '💘'),
      ]);
      return sock.sendMessage(from, { text: reply }, { quoted: msg });
    },
  },
  {
    name: 'horoscope',
    aliases: ['zodiac', 'horo'],
    description: 'Get daily horoscope for a zodiac sign.',
    category: 'Fun',
    execute: async ({ sock, from, msg, args }) => {
      const sign = String(args[0] || '').toLowerCase().trim();
      if (!sign || !ZODIAC_SIGNS.includes(sign)) {
        return sock.sendMessage(
          from,
          { text: `🔮 *Usage:* \`.horoscope <sign>\`\n*Signs:* ${ZODIAC_SIGNS.join(', ')}` },
          { quoted: msg },
        );
      }
      let date = new Date().toDateString();
      let forecast = pickRandom(HOROSCOPE_FALLBACKS);
      try {
        const res = await axios.get(
          `https://horoscope-app-api.vercel.app/api/v1/get-horoscope/daily?sign=${sign}&day=TODAY`,
          { timeout: 7000 },
        );
        if (res.data?.data?.horoscope_data) {
          forecast = res.data.data.horoscope_data;
          date = res.data.data.date || date;
        }
      } catch {}
      const label = sign.charAt(0).toUpperCase() + sign.slice(1);
      const reply = card(`${label} HOROSCOPE`, [
        spiderRow('SIGN', `${ZODIAC_EMOJIS[sign]} ${label}`, '🔮'),
        spiderRow('DATE', date, '📅'),
        spiderDivider('DAILY READING'),
        `> ┃ ${forecast}`,
        spiderFooter(`${botName()} // ASTROLOGY`),
      ].slice(0, -1));
      return sock.sendMessage(from, { text: reply }, { quoted: msg });
    },
  },
  {
    name: 'proverb',
    aliases: ['saying', 'wisdom', 'adage'],
    description: 'Get a random proverb or wise saying.',
    category: 'Fun',
    execute: async ({ sock, from, msg }) => {
      let pick = null;
      try {
        const res = await axios.get('https://api.sampleapis.com/proverbs/proverbs', { timeout: 6000 });
        if (Array.isArray(res.data) && res.data.length) {
          const item = pickRandom(res.data);
          if (item?.proverb) pick = { text: item.proverb, origin: item.tags?.[0] || 'Traditional' };
        }
      } catch {}
      if (!pick) pick = pickRandom(PROVERBS);
      const reply = card('PROVERB', [
        spiderRow('SAYING', `"${pick.text}"`, '📜'),
        spiderRow('ORIGIN', pick.origin || 'Traditional', '🏷️'),
      ]);
      return sock.sendMessage(from, { text: reply }, { quoted: msg });
    },
  },
  {
    name: 'numberfact',
    aliases: ['numfact', 'number'],
    description: 'Get an interesting fact about any number.',
    category: 'Fun',
    execute: async ({ sock, from, msg, args }) => {
      const raw = args[0];
      const num = raw !== undefined && !Number.isNaN(parseInt(raw, 10)) ? parseInt(raw, 10) : null;
      if (num === null) {
        return sock.sendMessage(
          from,
          { text: '🔢 Usage: `.numberfact <number>`\nExample: `.numberfact 42`' },
          { quoted: msg },
        );
      }
      if (NUMBER_FACTS[num]) {
        const reply = card(`NUMBER ${num}`, [spiderRow('FACT', NUMBER_FACTS[num], '🔢')]);
        return sock.sendMessage(from, { text: reply }, { quoted: msg });
      }
      const notes = [
        num % 2 === 0 ? `${num} is an even number.` : `${num} is an odd number.`,
        isPrime(num) ? `${num} is a prime number.` : `${num} is not prime.`,
      ];
      if (num > 0 && Number.isInteger(Math.sqrt(num))) {
        notes.push(`${num} is a perfect square (${Math.sqrt(num)}²).`);
      }
      const digitSum = String(Math.abs(num)).split('').reduce((a, b) => a + Number(b), 0);
      notes.push(`Digit sum: ${digitSum}.`);
      const reply = card(`NUMBER ${num}`, [
        spiderRow('FACTS', notes.join(' '), '🔢'),
      ]);
      return sock.sendMessage(from, { text: reply }, { quoted: msg });
    },
  },
  {
    name: 'animalfact',
    aliases: ['animalf'],
    description: 'Get a random animal fact.',
    category: 'Fun',
    execute: async ({ sock, from, msg }) => {
      return sock.sendMessage(
        from,
        { text: card('ANIMAL FACT', [spiderRow('FACT', pickRandom(ANIMAL_FACTS), '🐾')]) },
        { quoted: msg },
      );
    },
  },
  {
    name: 'spacefact',
    aliases: ['spacef'],
    description: 'Get a random space fact.',
    category: 'Fun',
    execute: async ({ sock, from, msg }) => {
      return sock.sendMessage(
        from,
        { text: card('SPACE FACT', [spiderRow('FACT', pickRandom(SPACE_FACTS), '🚀')]) },
        { quoted: msg },
      );
    },
  },
  {
    name: 'sciencefact',
    aliases: ['sciencef'],
    description: 'Get a random science fact.',
    category: 'Fun',
    execute: async ({ sock, from, msg }) => {
      return sock.sendMessage(
        from,
        { text: card('SCIENCE FACT', [spiderRow('FACT', pickRandom(SCIENCE_FACTS), '🔬')]) },
        { quoted: msg },
      );
    },
  },
  {
    name: 'historyfact',
    aliases: ['historyf'],
    description: 'Get a random history fact.',
    category: 'Fun',
    execute: async ({ sock, from, msg }) => {
      return sock.sendMessage(
        from,
        { text: card('HISTORY FACT', [spiderRow('FACT', pickRandom(HISTORY_FACTS), '📜')]) },
        { quoted: msg },
      );
    },
  },
  {
    name: 'techfact',
    aliases: ['techf'],
    description: 'Get a random technology fact.',
    category: 'Fun',
    execute: async ({ sock, from, msg }) => {
      return sock.sendMessage(
        from,
        { text: card('TECH FACT', [spiderRow('FACT', pickRandom(TECH_FACTS), '💻')]) },
        { quoted: msg },
      );
    },
  },
  {
    name: 'excuse',
    aliases: ['randomexcuse'],
    description: 'Generate a creative excuse.',
    category: 'Fun',
    execute: async ({ sock, from, msg }) => {
      return sock.sendMessage(
        from,
        { text: card('EXCUSE GENERATOR', [spiderRow('EXCUSE', pickRandom(EXCUSES), '🤥')]) },
        { quoted: msg },
      );
    },
  },
  {
    name: 'nickname',
    aliases: ['nick', 'randomnick'],
    description: 'Generate a cool gamer/handle nickname.',
    category: 'Fun',
    execute: async ({ sock, from, msg }) => {
      const adj = ['Shadow', 'Blazing', 'Swift', 'Mystic', 'Cosmic', 'Silver', 'Thunder', 'Phantom', 'Crimson', 'Nova', 'Turbo', 'Frost'];
      const nouns = ['Wolf', 'Phoenix', 'Dragon', 'Knight', 'Hawk', 'Ninja', 'Tiger', 'Falcon', 'Viper', 'Raven', 'Hunter', 'Blade'];
      const nick = `${pickRandom(adj)}${pickRandom(nouns)}${Math.floor(Math.random() * 99) + 1}`;
      return sock.sendMessage(
        from,
        { text: card('NICKNAME GENERATOR', [spiderRow('NICK', nick, '🏷️')]) },
        { quoted: msg },
      );
    },
  },
  {
    name: 'affirmation',
    aliases: ['affirm'],
    description: 'Receive a positive daily affirmation.',
    category: 'Fun',
    execute: async ({ sock, from, msg }) => {
      return sock.sendMessage(
        from,
        { text: card('DAILY AFFIRMATION', [spiderRow('AFFIRMATION', pickRandom(AFFIRMATIONS), '🌸')]) },
        { quoted: msg },
      );
    },
  },
  {
    name: 'dailychallenge',
    aliases: ['challenge'],
    description: 'Get a daily self-improvement challenge.',
    category: 'Fun',
    execute: async ({ sock, from, msg }) => {
      return sock.sendMessage(
        from,
        { text: card('DAILY CHALLENGE', [spiderRow('GOAL', pickRandom(CHALLENGES), '🎯')]) },
        { quoted: msg },
      );
    },
  },
  {
    name: 'dream',
    aliases: ['dreammeaning'],
    description: 'Look up common dream symbol interpretations.',
    category: 'Fun',
    execute: async ({ sock, from, msg, args }) => {
      const sym = String(args[0] || '').toLowerCase().trim();
      const entry = DREAMS[sym];
      if (!entry) {
        return sock.sendMessage(
          from,
          { text: `💭 Usage: \`.dream <symbol>\`\n*Available:* ${Object.keys(DREAMS).join(', ')}` },
          { quoted: msg },
        );
      }
      const reply = card(`DREAM // ${sym.toUpperCase()}`, [
        spiderRow('MEANING', entry.meaning, '💭'),
        spiderRow('ADVICE', entry.tip, '💡'),
      ]);
      return sock.sendMessage(from, { text: reply }, { quoted: msg });
    },
  },
];
