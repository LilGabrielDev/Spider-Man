export const CORE_AUTOBIOS = Object.freeze([
  // 1-10: Live Status & Telemetry
  '⚡ {bot} | Online & Ready • Up {uptime} ({time})',
  '🕷️ {bot} | Active 24/7 • {date} • {time}',
  '🚀 {bot} | Systems Nominal • Up {uptime}',
  '🟢 Connected & Responding • {time} ({date})',
  '⚡ Live on WhatsApp • Uptime {uptime}',
  '🛡️ {bot} | Automated & Secure • {time}',
  '🌐 Always Online • Synced at {time}',
  '📡 Signal Strong • {bot} Running Smoothly',
  '⏱️ Zero Downtime Mode • Up {uptime}',
  '✨ {bot} | Fast, Clean & Reliable ({date})',

  // 11-20: Focus & Hustle
  '🎯 Focused on goals, silent on noise.',
  '⚡ Building quietly, shipping daily.',
  '🔥 Progress over perfection, every single day.',
  '💼 Busy turning plans into reality.',
  '🧠 Deep work in progress — reply soon.',
  '⏳ Trading excuses for execution.',
  '🚀 Chasing growth, not attention.',
  '📈 1% better than yesterday.',
  '🛠️ Creating things that actually matter.',
  '⚡ Energy saved for things worth doing.',

  // 21-30: Calm & Minimalist
  '🌿 Peace of mind is my priority.',
  '☁️ Slow mornings, sharp focus, calm nights.',
  '🤍 Less clutter, more clarity.',
  '🌊 Flowing with patience and purpose.',
  '🕊️ Unbothered, grateful, and moving forward.',
  '🍃 Protecting my energy like treasure.',
  '☀️ Simple life, clear mind, good heart.',
  '🌙 Quiet space, loud ambitions.',
  '✨ Living in the present moment.',
  '🫧 Calm outside, unstoppable inside.',

  // 31-40: Ambition & Mindset
  '👑 Discipline beats motivation every time.',
  '💎 Pressure builds diamonds.',
  '🦅 Flying above temporary distractions.',
  '🔑 Consistency unlocks every locked door.',
  '⚡ Stay humble, stay hungry, stay sharp.',
  '🧭 Direction matters more than speed.',
  '🏆 Dream big, start small, act now.',
  '🔥 Outworking my old self.',
  '🪜 Step by step, mile by mile.',
  '🌟 Betting on myself every time.',

  // 41-50: Tech & Developer Vibes
  '💻 Eat. Sleep. Code. Deploy. Repeat.',
  '⚙️ Powered by coffee and clean logic.',
  '🖥️ Debugging life one line at a time.',
  '🤖 Automated by {bot} • {time}',
  '🔌 Plugged into the future.',
  '📡 Low latency, high uptime.',
  '🧩 Solving problems no one sees.',
  '⌨️ Shipping updates in real time.',
  '🔋 Battery charged, terminal open.',
  '🛰️ Running async in a sync world.',

  // 51-60: Good Vibes & Energy
  '✨ Good vibes only, no exceptions.',
  '🎧 Lost in good music and big ideas.',
  '🌈 Choosing joy in every little thing.',
  '☕ Fueled by coffee and ambition.',
  '🌞 Bringing sunshine to every chat.',
  '🎶 Rhythm in my soul, peace in my mind.',
  '💫 Attracting what belongs to me.',
  '🍀 Lucky are those who never quit.',
  '🔥 High spirit, warm heart, sharp mind.',
  '🌻 Growing through everything I go through.',

  // 61-70: Late Night & Chill
  '🌙 Night owl hours • Best ideas come after midnight.',
  '🌌 Stargazing while the world sleeps.',
  '🏙️ City lights, quiet thoughts, steady grind.',
  '🕯️ Late night focus hits different.',
  '🎧 Midnight playlist on repeat.',
  '🌠 Dreaming with my eyes wide open.',
  '🌑 Silent nights build loud futures.',
  '🍵 Late night tea and deep conversations.',
  '✨ Under the same stars, chasing different dreams.',
  '🛋️ Chill mode enabled — message anytime.',

  // 71-80: Short Wisdom & Quotes
  '📖 Write a story worth rereading.',
  '🕰️ Time reveals what words hide.',
  '🌱 Patience makes everything bloom on time.',
  '🪞 Fix your focus, fix your life.',
  '⚖️ Balance work, rest, and gratitude.',
  '🪨 Solid roots survive any storm.',
  '🔦 Be the light you wish to see.',
  '🎯 What you feed with focus grows.',
  '💭 Thoughts shape habits; habits shape destiny.',
  '🌤️ Every storm runs out of rain eventually.',

  // 81-90: Sleek Status One-Liners
  '📲 Text me, I might surprise you with a fast reply.',
  '💬 Available for good vibes and real talk.',
  '⚡ Short replies, genuine intentions.',
  '📌 Pinning dreams on the calendar.',
  '🚦 Green light to positivity only.',
  '🔒 Private life, peaceful mind.',
  '🧭 Exploring new paths every week.',
  '🏁 Never finished, always leveling up.',
  '⚡ Online now — drop your message.',
  '🎯 Keep it real or keep it moving.',

  // 91-100: Spider Man Signature & Dynamic Clock
  '🕷️ Spider-Sense tingling • {bot} ({time})',
  '🕸️ Connected across every chat • {date}',
  '⚡ Fast as lightning • {bot} v2',
  '🕷️ Swinging through tasks • Up {uptime}',
  '🔥 Precision, speed, style • {bot}',
  '🌐 Always in range • {time} UTC+Sync',
  '🎭 Work in silence, let results speak.',
  '🚨 Auto-Pilot Active • {bot} ({date})',
  '💠 Clean code, crisp vibes, zero noise.',
  '⚡ {bot} Auto-Bio Rotating • {date} {time}',
]);

export const EXTRA_BIO_TARGET = 10_000;
export const TOTAL_BUILTIN_BIOS = CORE_AUTOBIOS.length + EXTRA_BIO_TARGET; // 10,100

const HANDWRITTEN_ORIGINALS = {
  pickup: [
    "📶 Are you Wi-Fi? Because I'm feeling a super strong connection.",
    '🔋 Are you a charger? Because my energy jumps whenever you text.',
    '📸 Are you a camera? Because I smile every time your name pops up.',
    '🧲 Are you gravity? Because everything in my day pulls toward you.',
    '🧪 Are you copper and tellurium? Because you are purely Cu-Te.',
    '🗺️ Excuse me, I think I lost my map — got directions to your heart?',
    '🕰️ Are you a time traveler? Because I can already see us later.',
    '🎶 Are you Spotify? Because you keep topping my favorite playlist.',
    '☕ Are you morning coffee? Because I cannot function properly without you.',
    '🌙 Do you believe in love at first chat, or should I text again?',
    '📚 If beauty were chapters, you would already be my favorite book.',
    '🔭 Forget constellations — looking at you is plenty of stardust.',
    '🎹 Are you a melody? Because I keep humming your vibe all day.',
    '🔑 Are you the missing key? Because every lock feels easy with you.',
    '☀️ Did the sun come out early today, or did you just log on?',
    '🎲 Betting my whole weekend that one coffee with you beats anything.',
    '🧁 Are you a bakery? Because everything around you feels extra sweet.',
    '🚀 If flirting was orbit, you already pulled me past the moon.',
    '🧩 Found the missing piece of my mood — pretty sure it is you.',
    '⚡ Care if I borrow a kiss? Promise I will return it right back.',
    '🎯 My aim is usually terrible, yet I fell straight for you.',
    '🌟 If stars charged rent for shining, you would own the night sky.',
    '🍀 Didn’t believe in luck until your chat landed on my screen.',
    '🎧 You must be my favorite verse — I keep playing it in my head.',
    '🧠 My brain forgot 10 passwords today, yet memorized your smile instantly.',
    '🍓 Sweeter than strawberries, twice as refreshing as summer rain.',
    '🛫 Ready for takeoff — destination: dinner with you this Friday.',
    '💌 Not to be dramatic, but your typing indicator deserves confetti.',
    '🔥 Is it hot in here, or did you just open this chat?',
    '💎 Some people look for gold; I just hit reply on your message.',
    '🎨 Every time you smile, Monday starts looking like Saturday night.',
    '🚦 Green light all the way — tell me when you are free next.',
    '🐝 Are you honey? Because this conversation just got effortlessly sweet.',
    '📖 Quick question: what chapter do we finally grab ice cream together?',
    '🍫 Better than chocolate on a stressful day — and that is saying a lot.',
    '✨ Even autocorrect stopped fighting me when I typed your name.',
    '🎤 Drop the mic, you already won my attention before saying hey.',
    '🎈 Every message from you lifts my whole mood by ten floors.',
    '🧭 All roads somehow lead straight back to texting you again.',
    '🌺 Flowers get jealous when you walk past a sunny street.',
    '📱 My favorite sound on Earth is your notification ping.',
    '🕶️ Too cool to ignore, way too cute not to text twice.',
    '🥂 Raising a glass to the best distraction on my contact list.',
    '🕊️ Calmest peace I felt all week was hearing your laugh.',
    '💫 Just checking: did it hurt when you upgraded the whole room?',
    '🍿 Skip the movie trailer — let us just go straight to the date.',
    '🎵 You got the exact rhythm my quiet evenings were waiting for.',
    '🏆 Trophy unlocked: winning my undivided attention in one message.',
    '🌤️ Cloudy forecast outside, 100% sunshine inside this chat.',
    '😘 Smooth lines are overrated, so hey — how is my favorite person?',
  ],
  fun: [
    '🍕 Fitness tip: hold two slices of pizza to balance both hands.',
    '🛌 My bed and I are in a serious long-term relationship; alarms are haters.',
    '☕ Coffee: because anger management can get pricey on Mondays.',
    '🧠 Brain capacity today: remembered song lyrics from 2011, forgot my keys.',
    '📶 Home is wherever my phone connects to Wi-Fi automatically.',
    '🐢 Moving at my own speed — spoilers: mostly snack breaks.',
    '🛒 Went online to pay one bill, somehow ordered socks and LED lights.',
    '🎭 I am not lazy, I am simply on ultra battery-saving mode.',
    '⏰ Snooze button champion three years running — undefeated.',
    '🧃 Hydrated with 10% water and 90% questionable iced drinks.',
    '📱 Dropped my phone on my face again — gravity stays undefeated.',
    '🍪 Diet starts tomorrow. Tomorrow has been postponed since 2022.',
    '🕺 Dancing in the kitchen while waiting for the kettle to boil.',
    '🧾 Looked at my bank statement and whispered “plot twist.”',
    '🛋️ If sitting still was an Olympic sport, call me gold medalist.',
    '🎧 Wearing headphones with zero music just to avoid small talk.',
    '🔋 My social battery drains faster than a 1% iPhone in winter.',
    '🐸 Sipping tea silently while watching everyone rush for nothing.',
    '📦 Tracking a parcel I ordered six hours ago like it has wings.',
    '🦥 Speed limit in my house is strictly sloth mode after 8 PM.',
    '🍦 Life is short — eat the dessert before reading the menu twice.',
    '📵 Put my phone on silent, then missed it like an old friend.',
    '🤡 Told myself “just one episode” four hours and a whole season ago.',
    '🥤 If iced drinks were fuel, I could orbit Jupiter by noon.',
    '🦆 Calm on the surface, paddling furiously for the weekend.',
    '💡 Great ideas arrive strictly in the shower with zero pen nearby.',
    '🥨 Twisted like a pretzel trying to fix my posture right now.',
    '🧀 Sweet dreams are literally made of melted cheese and fries.',
    '📚 Bought five books to read, currently rereading group chat drama.',
    '🎈 Acting surprised when staying up till 3 AM makes me sleepy.',
    '🕶️ Too tired to argue, too awake to sleep — welcome to midnight.',
    '🍿 Came for five minutes of peace, stayed for three seasons.',
    '🍌 Slightly bruised, still sweet, doing my absolute best.',
    '🛸 Waiting for aliens to explain why socks vanish in the dryer.',
    '🎮 One more round means bedtime moved ahead by two hours.',
    '🍩 Donut stress over things you cannot sprinkle with positivity.',
    '🐾 Follow my own pace — mostly heading straight toward snacks.',
    '🎤 Singing loudly in private like I actually booked a stadium tour.',
    '🧊 Cool as ice until the food delivery takes a wrong turn.',
    '🧩 Half put together, somehow still finishing the picture.',
    '📅 Today’s schedule: open laptop, look worried, grab a snack.',
    '🎲 Rolling the dice on whether a 20-minute nap becomes 4 hours.',
    '🚀 Launching out of bed strictly when lunch smells good.',
    '⚡ Fast at replying to memes, mysteriously slow at formal emails.',
    '🌮 Taco Tuesday is technically a valid mood every day of the week.',
    '🧠 Overthinking level: rehearsing conversations that will never happen.',
    '🎧 Shuffle picked three bangers in a row — today is blessed.',
    '🌵 Low maintenance, needs occasional sunlight and cold water.',
    '🧁 Sweet enough to share, sharp enough to keep receipts.',
    '🏁 Made it through today using humor, hope, and snack breaks.',
  ],
  tech: [
    '💻 Works on my machine — shipping that attitude straight to prod.',
    '🐛 Fixed one bug, unlocked two bonus mysteries for tomorrow.',
    '⚡ Turning caffeine into semicolons and clean API responses.',
    '⌨️ Ctrl+Z is honestly the best superpower ever invented.',
    '🖥️ Dark mode everywhere because light attracts actual bugs.',
    '🤖 Teaching bots better manners than most group chats.',
    '📡 99.9% uptime, 0.1% staring silently at console logs.',
    '🔍 Searching StackOverflow with the humility of a beginner daily.',
    '⚙️ Refactoring yesterday’s “quick temporary fix” from six months ago.',
    '💾 Saved, committed, pushed, and praying silently to the build gods.',
    '🔐 Keeping my circle smaller than my environment variable list.',
    '🧪 Automated tests passed — suspicious, running them one more time.',
    '🌐 Talking in JSON, dreaming in TypeScript, living async.',
    '📦 Node modules heavier than my weekend backpack.',
    '🚀 Deployed without breaking prod — time for victory coffee.',
    '🧠 Cache cleared, mind still buffering after 2 AM deploys.',
    '🛰️ Ping low, spirits high, terminal cleaner than my desk.',
    '🔧 If it looks simple, someone spent six hours polishing the edge cases.',
    '🔌 Recharging my creativity at 100W USB-C speed.',
    '🎯 Clean architecture, tiny diffs, peaceful weekends.',
  ],
  savage: [
    '👑 Never competing where I already set the pace.',
    '🔒 Access upgraded to invitation-only — apply respectfully.',
    '⚡ Quietly outgrowing rooms I used to beg to enter.',
    '💎 Rare energy: never loud, never fake, never rattled.',
    '🦁 Calm face, sharp instincts, unshakeable boundaries.',
    '🧊 Cold with distractions, warm with genuine loyalty.',
    '🎯 Say less, deliver twice, keep them guessing.',
    '🔥 Built from setbacks nobody saw me survive.',
    '⚖️ Giving everyone the exact energy they mailed first.',
    '🦅 Eagles don’t hold meetings with pigeons about altitude.',
    '🚪 Some doors closed just to save you from cheap rooms.',
    '🛡️ My peace costs zero drama to keep around.',
    '✨ Underestimated twice, undefeated quietly every round.',
    '🏁 Not rushing the climb when I own the direction.',
    '💬 Short answers mean my focus is already booked.',
    '🧲 Real ones recognize real effort without a speech.',
    '🌋 Quiet mountain, massive power underneath.',
    '⏳ Time puts everybody right where their actions deserve.',
    '🧭 Loyal to growth, allergic to repeated excuses.',
    '🏆 Letting results handle every loud opinion.',
  ],
  wisdom: [
    '🌱 Small daily habits build empires overnight crowds miss.',
    '🌊 A calm sea never trained a fearless captain.',
    '🕰️ Protect your hours like gold; they never refund.',
    '🔦 Kindness costs nothing yet echoes in rooms you leave.',
    '⛰️ Steep climbs unlock the cleanest sunrise views.',
    '📖 Listen twice as long as you feel urged to speak.',
    '🪞 Your future reflects what you tolerate quietly today.',
    '🌤️ Tough seasons pass; resilient character stays permanently.',
    '🧭 Slow progress in the right lane beats fast circles.',
    '💎 Discipline is choosing what you want most over now.',
    '🌿 Rest is part of the work, not a betrayal of it.',
    '🔑 Gratitude turns ordinary days into quiet celebrations.',
    '🕊️ Forgive for your own lightness, remember for your wisdom.',
    '🔥 Speak truth gently, walk your path boldly.',
    '🌠 Never shrink a God-sized vision to fit small comfort.',
    '⚖️ Peace starts the moment comparison ends.',
    '🪴 Water your own grass instead of eyeing neighbors’ fences.',
    '🛤️ Every detour still teaches something vital for the road ahead.',
    '🌟 Be the person younger-you always hoped you would become.',
    '🌅 Tomorrow wakes up new no matter how heavy yesterday felt.',
  ],
};

// Carefully curated grammatical building blocks so every combination reads naturally.
const NICE_THINGS = [
  'a Friday afternoon', 'cold water at 3 AM', 'zero Monday alarms',
  'skipping rush-hour traffic', 'the cool side of the pillow', 'free Wi-Fi on a long trip',
  'fresh coffee on a rainy morning', 'a golden-hour sunset', 'getting paid two days early',
  'a clear starlit sky', 'extra fries in the bag', 'sleeping in on Sunday',
  'finding forgotten cash in a jacket', 'perfect breezy weather', 'an empty inbox',
  'late-night highway drives', 'catching every green light', 'your favorite song on shuffle',
  'warm sunlight after rain', 'five-star street tacos', 'peaceful Saturday mornings',
  'a freshly baked pastry', 'fast battery charging', 'a quiet beach breeze',
  'winning an argument effortlessly', 'front-row concert seats',
];

const SWEET_COMPLIMENTS = [
  'seeing your name pop up online', 'getting one text from you', 'hearing your laugh today',
  'five minutes talking with you', 'the way you brighten this chat', 'any excuse to message you',
  'catching you online at midnight', 'your effortless warm vibe', 'reading your first reply',
  'having your attention tonight', 'making you smile through a screen', 'sharing quiet jokes with you',
  'learning all your favorite songs', 'knowing you are on my contact list', 'your unmatched charming energy',
  'starting my morning with your hey', 'watching you tease me over text', 'keeping you as my favorite chat',
  'stealing a slow coffee together', 'every second you type back', 'your mind and your humor',
  'getting a surprise voice note from you', 'having you as my favorite plot twist', 'talking until we lose track of time',
  'catching feelings without even trying', 'seeing your eyes light up', 'knowing we are on the same wavelength',
  'making memories nobody else gets',
];

const FLIRT_LEADS = [
  'Quick confession', 'Smooth reminder', 'Honest review', 'Breaking news',
  'Side note', 'Fun fact', 'Public notice', 'Daily update',
  'Tiny secret', 'Friendly warning', 'Serious question', 'Plot twist',
  'Status update', 'Verified truth', 'Gentle flex', 'True story',
  'Real talk', 'Sweet reminder', 'Open secret', 'Direct update',
  'Late bulletin', 'Official report', 'Charm check', 'Fair disclaimer',
  'VIP notice',
];

const FLIRT_HOOKS = [
  'my favorite notification is still your name',
  'you make ruining my sleep schedule completely worth it',
  'I checked the menu and the best item is still me-n-u',
  'you are the sole reason my screen lights up faster',
  'replying fast is my main love language with you',
  'I am awful at flirting so just pretend I winked right now',
  'even autocorrect waits eagerly for your name',
  'my phone battery works overtime whenever you text',
  'you outshine every sunset I forgot to take photos of',
  'you already had my attention before you even hit send',
  'I only stay online this late hoping you say hey',
  'your vibe deserves a permanent pinned spot at the top',
  'other chats vanish mysteriously whenever you message',
  'if smiling were a sport you would owe me a gold medal',
  'forgot my smooth line — how is my favorite human doing',
  'I would pause my favorite show just to reply to you',
  'calling dibs on being your favorite distraction this week',
  'you just upgraded my entire mood in three little words',
  'you look exactly like my next favorite memory',
  'you must be gravity because I keep falling right back',
  'even Monday starts acting polite when you text first',
  'two minutes talking with you beats two hours anywhere else',
  'lowkey hoping your thumb slips and sends me a hey',
  'you are the only chat I flat-out refuse to mute',
  'spoiler alert: you are still living rent-free in my thoughts',
  'my playlists suddenly make perfect sense because of you',
  'saving my absolute best energy strictly for your messages',
  'if charm came with a speeding ticket you would owe millions',
  'you make small talk feel like front-row magic',
  'pretty sure fate added your number just to make me smile',
  'my coffee got jealous seeing how fast you wake me up',
  'hard to stay focused when you keep looking that good',
  'consider this an open invitation to ruin my focus anytime',
  'every time we talk the clock starts sprinting',
  'honestly just happy we exist in the same timeline',
];

const CHARM_SUBJECTS = [
  'Your smile', 'Your voice', 'Your energy', 'That laugh', 'Your vibe',
  'Talking to you', 'Your charm', 'One text from you', 'Your presence', 'Your playlist',
  'Your humor', 'Your warmth', 'Late chats with you', 'Seeing you online', 'Your mind',
  'Your kindness', 'Every reply from you', 'Your confidence', 'Meeting you', 'Your aura',
  'Your wit', 'That sweet tone', 'Your sparkle', 'Your style', 'Your honesty',
];

const CHARM_REACTIONS = [
  'just broke my focus completely again',
  'deserves VIP seating inside my thoughts',
  'is dangerously addictive in the best way',
  'makes the whole day feel effortless',
  'beats every other plan I made tonight',
  'turns ordinary hours into bright highlights',
  'has zero competition around here',
  'hits smoother than my favorite song',
  'is my absolute favorite kind of trouble',
  'makes me forget whatever annoyed me earlier',
  'easily scores an eleven out of ten',
  'feels like warm sunshine after heavy rain',
  'makes hitting reply way too easy',
  'just raised the standard for everyone else',
  'leaves me grinning silently at my phone',
  'is totally worth staying awake past midnight',
  'works faster than two cups of morning coffee',
  'is pure magic without needing any tricks',
  'brightens any slow afternoon effortlessly',
  'turns a stubborn mood around in seconds',
  'never misses the mark even once',
  'is unfairly charming without trying',
  'stays rent-free inside my head all week',
  'puts every boring routine on pause',
  'makes me look forward to tomorrow already',
];

const PLAYFUL_CONDITIONS = [
  'smiles paid rent', 'texting you charged batteries', 'charm carried a fine',
  'missing you burned calories', 'good vibes shipped overnight', 'flirting had a final exam',
  'sweet texts cured headaches', 'compliments grew orchards', 'daydreams paid overtime',
  'eye contact sent Wi-Fi', 'weekends started with your hey', 'wishes loaded at fiber speed',
  'affection worked like Bluetooth', 'jokes required a permit', 'destiny sent calendar invites',
  'sunsets copied your glow', 'patience won gold trophies', 'your voice broke records',
  'crushes came with receipts', 'laughs cured bad Mondays', 'sparkles left footprints',
  'hugs shipped in boxes', 'your name triggered confetti', 'stars answered text polls',
  'butterflies ran airlines',
];

const PLAYFUL_OFFERS = [
  'never log off tonight', 'owe you an entire galaxy', 'frame your very last text',
  'reply in under half a second', 'pin your chat to the clouds', 'stay awake till sunrise talking',
  'turn read receipts back on for you', 'send fresh playlists every evening', 'let you pick every movie',
  'still choose your chat first', 'celebrate like it is always Friday', 'make extra hours appear',
  'grin at every single ping', 'skip every boring meeting gladly', 'keep your number pinned at #1',
  'show up ten minutes early every time', 'share the very last slice with you', 'never let our vibe cool down',
  'always bet everything on us', 'write a whole song about your laugh', 'book us the quiet corner table',
  'trade snoozing for morning texts', 'save every inside joke forever', 'match your vibe step for step',
  'smile before reading the first word',
];

const FUN_ACTIVITIES = [
  'reheating the same cup of tea', 'overthinking a three-word reply', 'staring into an empty fridge',
  'planning trips I never booked', 'arguing gently with my alarm clock', 'curating imaginary playlists',
  'scrolling way past bedtime again', 'testing where the Wi-Fi drops', 'pretending to look mysterious',
  'replaying one chorus forty times', 'napping like a retired cat', 'watching trailers instead of movies',
  'hoarding twenty-nine browser tabs', 'tracking parcels every ten minutes', 'laughing silently at old memes',
  'looking busy with minimal output', 'eating dessert before real dinner', 'checking time then forgetting it',
  'brewing coffee at 10 PM', 'daydreaming in full 4K resolution', 'dodging awkward small talk smoothly',
  'reading memes like breaking news', 'rehearsing imaginary award speeches', 'winning yesterday’s debate quietly',
  'color-coding apps I never open', 'playing voice notes at 2x speed', 'recharging an empty social battery',
  'forgetting why I unlocked my phone', 'filling shopping carts without buying', 'hunting motivation under cushions',
];

const ADULT_DUTIES = [
  'being a model adult', 'answering serious emails', 'fixing my sleep schedule',
  'folding that chair of laundry', 'clearing my real to-do list', 'sleeping before midnight',
  'drinking eight glasses of water', 'touching fresh grass outside', 'acting like a serious grown-up',
  'deleting blurry screenshots', 'tidying up my cluttered desk', 'reading terms and conditions',
  'checking my monthly budget', 'waking up on the first alarm', 'cooking balanced meals',
  'replying within ten minutes', 'staying off screens after dark', 'making wise impulse choices',
  'starting that Monday workout', 'sorting unread notifications', 'sticking strictly to the plan',
  'acting totally normal in public', 'taking small delays calmly', 'paying attention in meetings',
  'wrapping up early chores',
];

const FUN_STATUS_TAGS = [
  'Vibe check:', 'Mood forecast:', 'Current setting:', 'Mental tabs:', 'Energy report:',
  'Personal policy:', 'Plot twist:', 'Life update:', 'Survival kit:', 'Daily memo:',
  'Status report:', 'Current chapter:', 'Official bio:', 'Weekend plan:', 'Quick disclaimer:',
  'Screen report:', 'Snack forecast:', 'Social battery:', 'Coffee index:', 'Alarm policy:',
  'Thought traffic:', 'Schedule today:', 'Operating mode:', 'Brain capacity:', 'Focus meter:',
];

const FUNNY_CLAUSES = [
  '90% calm vibes, 10% figuring out what day it is',
  'running purely on iced drinks and stubborn optimism',
  'if I am typing, expect either a meme or a typo',
  'unavailable for nonsense between 12 AM and 12 AM',
  'online right now yet mentally relaxing at the beach',
  'trying to act serene while twelve tabs play music',
  'putting the absolute pro inside gentle procrastination',
  'officially accepting hot fries as sincere apologies',
  'mildly allergic to early mornings and ten-minute voice notes',
  'sending good energy — delivery takes three business days',
  'doing my absolute best on zero sleep and crisp playlists',
  'never ask my schedule because even I get surprised daily',
  'active on WhatsApp, buffering quietly in real life',
  'powered by comedy, luck, and suspiciously late dinners',
  'yes I read it, yes I replied inside my head cleanly',
  'mentally out of office staring peacefully at the ceiling',
  'professional snack critic, amateur morning person',
  'patience battery drops faster than 1% in cold weather',
  'still recovering smoothly from yesterday’s accidental three-hour nap',
  'part-time strategist, full-time hungry at midnight',
  'silently judging weak tea since 7:00 AM sharp',
  'please allow five full minutes for my soul to boot up',
  'born strictly to chill, politely forced to answer pings',
  'fluent in light sarcasm and sending reaction stickers',
  'living proof that warm coffee rescues almost any Monday',
  'hold tight — my brain casually toggled airplane mode',
  'making bold snack decisions with zero hesitation',
  'offline in spirit, online strictly out of pure muscle memory',
  '100% authentic, 0% functional before breakfast arrives',
  'currently welcoming funny reels and verified good news only',
  'if found wandering, please return me to snacks and Wi-Fi',
  'loading ambition... slight delay, please check after lunch',
];

const DAY_ROLES = [
  'Overthinker', 'Coffee lover', 'Bug fixer', 'Snack hunter', 'Playlist curator',
  'Daydreamer', 'Meme collector', 'Quiet achiever', 'Joke writer', 'Late replier',
  'Keyboard ninja', 'Vibe inspector', 'Peace keeper', 'Goal chaser', 'Idea builder',
  'Music addict', 'Wi-Fi seeker', 'Screen tapper', 'Story teller', 'Silent observer',
  'Budget chef', 'Focus monk', 'Trivia fan', 'Cloud watcher', 'Task juggler',
];

const NIGHT_ROLES = [
  'midnight philosopher', 'kitchen fridge explorer', 'shuffle button abuser', 'ceiling starer',
  '2 AM genius', 'pillow negotiator', 'sleep procrastinator', 'movie marathoner',
  'secret snack thief', 'quiet star gazer', 'rain sound listener', 'late-night coder',
  'dream traveler', 'podcast binge listener', 'battery saver pro', 'peace seeker',
  'deep thinker', 'playlist architect', 'music critic', 'water bottle sipper',
  'moon watcher', 'tomorrow planner', 'blanket burrito', 'silent legend',
  'episode cliffhanger victim',
];

const QUIRKY_HABITS = [
  'chronically online', 'easily bribed by good food', 'mildly over-caffeinated',
  'historically anti-morning', 'fluent in movie quotes', 'hungry strictly after 11 PM',
  'still buffering before 9 AM', 'strangely strong at random trivia', 'curious about everything weird',
  'emotionally loyal to snacks', 'serial song repeater', 'professional browser tab hoarder',
  'fueled by cold iced coffee', 'blessed with fast thumbs', 'proudly nocturnal by choice',
  'lowkey comedy fan', 'hopelessly hooked on stories', 'wired for spontaneous trips',
  'mildly obsessed with memes', 'always backing the underdog', 'surviving on pure plot armor',
  'dangerously honest when sleepy', 'habitually dodging phone calls', 'chronically losing lip balm',
  'built from wit and patience',
];

const QUIRKY_TRAITS = [
  'bad at hiding facial expressions', 'allergic to one-word dry replies', 'honest even with awful puns',
  'awaiting Friday since Tuesday noon', 'saving reaction memes for emergencies', 'secretly smiling at random dogs',
  'relying dangerously on autocorrect', 'never declining free garlic bread', 'talking fast when genuinely excited',
  'ready to nap on immediate notice', 'overthinking three-word texts daily', 'laughing before telling the punchline',
  'collecting ambitious half-done hobbies', 'humming catchy songs while shopping', 're-checking locked doors twice',
  'adding outfits to wishlists silently', 'sipping coffee strictly for morale', 'forgetting names inside four seconds',
  'vibing calmly regardless of chaos', 'staying completely unbothered on cue', 'taking longer scenic routes home',
  'cheering quietly for peaceful plots', 'suppressing giggles in serious rooms', 'misplacing keys while holding them',
  'checking the fridge expecting surprises',
];

const BUSY_FOCUSES = [
  'focused on real growth', 'locked onto bigger goals', 'committed to inner peace',
  'busy building something solid', 'invested in personal clarity', 'serious about clean boundaries',
  'proud of quiet progress', 'grounded inside self-respect', 'occupied crafting my next win',
  'disciplined with my schedule', 'driven by clear vision', 'patient with divine timing',
  'grateful for steady steps', 'aligned with genuine energy', 'steady inside my own lane',
  'mindful of my tight circle', 'busy upgrading my daily habits', 'calm beneath sudden pressure',
  'intent on guarding my joy', 'booked with quiet self-mastery', 'sharp with my top priorities',
  'clear about my true value', 'happy inside my own company', 'consistent behind closed doors',
  'selective about shared time', 'ready for much bigger tables', 'faithful to the slow process',
  'confident without needing noise', 'zeroed into true excellence', 'secure in my chosen direction',
];

const IGNORE_NOISES = [
  'argue with empty noise', 'chase temporary applause', 'explain myself three times',
  'replay expired drama', 'compete with loud egos', 'entertain lazy half-effort',
  'stress over cheap opinions', 'force wrong doors open', 'shrink for small comfort',
  'answer petty negativity', 'rush seasons meant to ripen', 'beg anyone for basic respect',
  'doubt proven instincts', 'chase hollow internet hype', 'hear critics building nothing',
  'linger where I am undervalued', 'lose sleep over stale gossip', 'settle for broken promises',
  'trade serenity for attention', 'copy another person’s blueprint', 'debate with closed minds',
  'fear starting from scratch', 'lower hard-earned standards', 'justify peaceful boundaries',
  'wait passively for permission',
];

const SAVAGE_LEADS = [
  'Standard check', 'Quick reminder', 'Energy rule', 'Circle policy',
  'Loyalty note', 'No excuses', 'Quiet flex', 'House rule',
  'Fair warning', 'Plain truth', 'Life filter', 'Zero drama',
  'Core rule', 'Respect check', 'Daily code', 'Crown note',
  'Clear signal', 'Access note', 'Vibe policy', 'Hard wisdom',
];

const SAVAGE_ENDS = [
  'protect your peace just like your banking password',
  'quiet execution speaks louder than three-minute rants',
  'warm kindness is never an invitation for disrespect',
  'consistent actions outshine fancy speeches every single time',
  'my absence will explain everything my patience tolerated',
  'tiny genuine circle, zero counterfeit smiles allowed',
  'matching steady loyalty, skipping confusing mixed signals',
  'never mistake soft manners for an easy target',
  'real growth looks lonely right before it looks legendary',
  'do not test a peaceful soul’s final boundary',
  'fewer announcements, much heavier finished results',
  'your consistency decides your level of access here',
  'keep things authentic — filters fade eventually',
  'never open all day for part-time effort',
  'no need to compete where I never wanted a seat',
  'keep it honest because shortcuts always ask for interest',
  'respect stays automatic right until proven optional',
  'moving in silence hits way harder than flexing early',
  'small trusted table, uncompromising standards',
  'do not expect VIP speed for casual effort',
  'elevate the conversation or step aside gracefully',
  'self-respect beats every convenient compromise',
  'built carefully from setbacks, never handed shortcuts',
  'pay close attention to who claps while you climb',
  'equal effort receives the exact same energy back',
];

const TECH_ACTIONS = [
  'Compiling bold ideas', 'Shipping clean commits', 'Refactoring legacy habits',
  'Debugging life silently', 'Deploying crisp workflows', 'Optimizing morning focus',
  'Testing resilient dreams', 'Streaming calm focus', 'Automating boring chores',
  'Hardening quiet boundaries', 'Crafting tiny tools', 'Syncing async goals',
  'Benchmarking better routines', 'Patching old excuses', 'Scaling side projects',
  'Monitoring clear uptime', 'Rendering bright visions', 'Indexing useful lessons',
  'Encrypting private plans', 'Tuning low-latency vibes', 'Building smart scripts',
  'Polishing edge cases', 'Routing clean thoughts', 'Upgrading core skills',
  'Shipping steady progress',
];

const TECH_OUTCOMES = [
  'zero unnecessary drama in prod', 'clean logs and clear mornings', 'faster loops every sprint',
  'stable releases all week long', 'pure coffee-fueled precision', 'happy terminals and calm nights',
  'fewer bugs than last Tuesday', 'built to run smoothly offline', 'small diffs, massive impact',
  'automated peace of mind', 'high signal, zero noise', 'documented wins only',
  'running clean on dark mode', 'ready for scale anytime', 'crafted line by careful line',
  'shipped ahead of Friday', 'zero memory leaks in mindset', 'built with patience and grit',
  'solid architecture underneath', 'smooth handoffs all day', 'tested under real pressure',
  'fast builds, lighter stress', 'cleaner code than yesterday', 'powered by curiosity alone',
  'graceful fallbacks everywhere',
];

const TELEMETRY_LABELS = [
  'System Heartbeat', 'Live Pulse', 'Node Status', 'Relay Check', 'Signal Matrix',
  'Daemon Watch', 'Core Monitor', 'Auto-Status', 'Uptime Feed', 'Socket Health',
  'Bot Telemetry', 'Spider Sync', 'Route Guard', 'Session Pulse', 'Edge Beacon',
  'Runtime Log', 'Cloud Presence', 'Active Loop', 'Status Link', 'Engine Check',
  'Mesh Ping', 'Frame Sync', 'Command Bus', 'Grid Watch', 'Live Anchor',
];

const TELEMETRY_NOTES = [
  'Smooth & steady', 'Zero packet loss vibes', 'Clean queue, fast reply',
  'Locked & responsive', 'Cruise control engaged', 'Fresh tick synced',
  'Healthy memory & calm vibes', 'Ready for incoming commands', 'Steady pulse online',
  'Synced cleanly to {date}', 'Active through {time}', 'Up {uptime} cleanly',
  'Running light & fast', 'No errors in sight', 'Guarding chats smoothly',
  'Instant response mode', 'Calm loop rotating', 'Verified live presence',
  'Balanced load & sharp speed', 'Always one ping away',
];

const WISDOM_LEADS = [
  'Daily thought', 'Quiet truth', 'Note to self', 'Golden rule', 'Mindset check',
  'Life note', 'Small truth', 'Inner compass', 'Morning note', 'Evening wisdom',
  'Real clarity', 'Perspective', 'Core lesson', 'Peace note', 'Steady truth',
  'Growth tip', 'Gentle rule', 'Soul check', 'Timeless note', 'Clear lens',
];

const WISDOM_BODIES = [
  'small steady steps quietly beat sudden bursts of hype',
  'patience protects what impatience tries to rush prematurely',
  'never confuse busy noise with meaningful forward movement',
  'calm confidence needs zero loud announcements',
  'what you water daily will eventually fill your garden',
  'protecting your mornings upgrades your entire week',
  'listening deeply solves half of every disagreement',
  'curiosity keeps life fresh long after youth fades',
  'consistency turns modest talent into unmistakable mastery',
  'kindness lingers far longer than clever comebacks',
  'rest intentionally so your ambition stays healthy',
  'comparison steals joy straight from your own progress',
  'grateful hearts spot blessings hurried eyes walk past',
  'tough days shape sturdy roots hidden beneath the surface',
  'speak gently, build patiently, verify quietly',
  'let yesterday teach you without letting it trap you',
  'character shines brightest when nobody is watching',
  'keep learning so every room stays an opportunity',
  'simplify your priorities until the essentials shine clearly',
  'your direction matters infinitely more than someone’s speed',
  'peaceful minds make sharper decisions under real heat',
  'start imperfectly today rather than waiting endlessly for ideal',
  'good boundaries let genuine generosity last years',
  'never trade long-term pride for quick applause',
  'grace handles surprises better than rigid perfection',
  'every finished chapter needed a brave first page',
  'stay teachable even after winning big milestones',
  'gratitude turns enough into a quiet feast',
  'clarity arrives quickly once distractions leave quietly',
  'celebrate small wins so big journeys stay joyful',
];

const GOOD_CHOICES = [
  'steady consistency', 'inner serenity', 'genuine loyalty', 'long-term vision',
  'honest effort', 'quiet discipline', 'deep rest', 'real friendships',
  'humble learning', 'patient craft', 'clear boundaries', 'clean intentions',
  'calm communication', 'daily gratitude', 'brave starts', 'focused mornings',
  'kindness first', 'authentic growth', 'balanced living', 'truthful words',
  'smart preparation', 'meaningful work', 'joyful simplicity', 'self-respect',
  'steady progress',
];

const BAD_CHOICES = [
  'overnight empty hype', 'pointless arguments', 'fake social approval', 'rushed shortcuts',
  'performative busyness', 'borrowed opinions', 'chronic exhaustion', 'crowded fake tables',
  'stubborn pride', 'loud excuses', 'one-sided loyalty', 'murky half-truths',
  'petty overreactions', 'endless scrolling', 'fear of failing', 'chaotic procrastination',
  'cynical gossip', 'comparison traps', 'burned-out hustling', 'empty promises',
  'reckless rushing', 'hollow distractions', 'cluttered schedules', 'people-pleasing',
  'yesterday’s regrets',
];

const TIME_WINDOWS = [
  'Midnight hours', 'Rainy evening', 'Sunday afternoon', 'Coffee break',
  'Golden hour', 'Early morning breeze', 'Late-night drive', 'Quiet dusk',
  'Blue-hour mood', 'Starlit balcony', 'Slow Saturday', 'After-hours calm',
  'Window-seat thoughts', 'Neon city twilight', 'Fresh dawn light', 'Warm twilight',
  'Cozy indoor rain', 'Moonlit playlist', 'Clear horizon', 'Desk-lamp focus',
  'Weekend exhale', 'Acoustic sunset', 'Deep evening chill', 'Sunrise ritual',
  'Twilight reset',
];

const CHILL_SCENES = [
  'soft lo-fi beats and warm chamomile tea',
  'slow breathing while the neighborhood settles down',
  'headphone concert for an audience of one',
  'cool air, warm hoodie, unhurried thoughts',
  'turning down the noise to hear my own pace',
  'watching city lights flicker beneath calm skies',
  'replaying old classics that never lose warmth',
  'zero rush, soft lighting, peaceful heart',
  'sketching future plans in neat tiny lines',
  'letting today’s stress evaporate gently outside',
  'sipping cold water and appreciating simple grace',
  'clouds drifting like slow ships overhead',
  'good stories, soft rain, comfortable silence',
  'keeping the phone close for only genuine people',
  'quiet gratitude for surviving another busy week',
  'stretching out time between favorite tracks',
  'warm light, calm breathing, clean slate ahead',
  'enjoying silence that doesn’t feel awkward',
  'unplugged from drama, synced cleanly with peace',
  'gentle breeze carrying fresh energy through the room',
  'resting tired eyes before another bold morning',
  'finding magic inside small quiet corners',
  'no deadlines tonight — strictly smooth vibes',
  'letting the rhythm handle the mood effortlessly',
  'thankful for calm nights and steady mornings',
];

const HUSTLE_ACTIONS = [
  'Show up disciplined', 'Build silently', 'Stack small wins', 'Stay patient',
  'Sharpen your craft', 'Keep your promises', 'Guard your focus', 'Outwork doubts',
  'Invest wisely', 'Learn relentlessly', 'Execute cleanly', 'Finish what you start',
  'Protect your mornings', 'Move intentionally', 'Train your patience', 'Respect the grind',
  'Focus on mastery', 'Stay adaptable', 'Think five moves ahead', 'Deliver high quality',
  'Keep showing up', 'Stay grounded', 'Work cleanly', 'Trust your habits',
  'Refine your systems',
];

const HUSTLE_REWARDS = [
  'future-you walks with effortless confidence',
  'luck eventually looks just like preparation',
  'nobody can deny your finished proof',
  'tomorrow opens doors you once knocked on',
  'opportunity finds you completely ready',
  'your results tell the story without bragging',
  'freedom stops feeling like a distant wish',
  'peace meets pride at the finish line',
  'small seeds turn into undeniable shade',
  'challenges shrink next to your discipline',
  'every tough hour pays quiet dividends',
  'your standards set the room’s temperature',
  'steady momentum carries the heavy weight',
  'dreams stop staying trapped inside notes',
  'progress compounds faster than distractions',
  'your craft speaks in every single room',
  'doubt runs out of valid arguments',
  'confidence grows out of real receipts',
  'setbacks turn smoothly into stepping stones',
  'your calm becomes your sharpest edge',
  'milestones arrive right on schedule',
  'patience feels worthwhile in hindsight',
  'quality outlives loud quick trends',
  'every sacrifice starts making complete sense',
  'you outgrow limits you used to fear',
];

const CHAT_TOPICS = [
  'good music', 'late-night food', 'crazy travel stories', 'underrated movies',
  'coding side projects', 'favorite childhood snacks', 'unpopular opinions', 'coffee spots',
  'weekend adventures', 'wild conspiracy jokes', 'book recommendations', 'dream vacations',
  'funny pet videos', 'midnight philosophies', 'gaming setups', 'hidden playlists',
  'random trivia', 'street food legends', 'weird dreams', 'comedy specials',
  'productivity hacks', 'sunset spots', 'favorite sports moments', 'new AI gadgets',
  'bad pickup lines',
];

const WARM_GIFTS = [
  'unexpected good news', 'calm peaceful mornings', 'genuine belly laughs',
  'smooth green lights', 'a surprisingly great playlist', 'reasons to smile randomly',
  'warm unhurried chats', 'gentle answers to heavy worries', 'steady progress on big goals',
  'cold refreshing drinks', 'zero unnecessary headaches', 'kind strangers along your route',
  'deep restful sleep', 'creative sparks that stick', 'comforting company nearby',
  'small victories worth celebrating', 'clear sunny skies', 'effortless focus all afternoon',
  'good food shared warmly', 'fresh hope for next month', 'quiet pride in your work',
  'lighthearted jokes on tough days', 'loyal friends texting first', 'bright moments out of nowhere',
  'calm strength through anything',
];

function addUnique(buckets, category, line) {
  const clean = String(line || '').replace(/\s+/g, ' ').trim();
  if (!clean || clean.length > 130) return;
  if (!buckets[category]) buckets[category] = [];
  buckets[category].push(clean);
}

function buildGeneratedCatalog() {
  const seenCore = new Set(CORE_AUTOBIOS.map((b) => b.trim()));
  const buckets = {
    pickup: [],
    fun: [],
    savage: [],
    tech: [],
    wisdom: [],
    vibes: [],
    hustle: [],
    social: [],
    warm: [],
    telemetry: [],
  };

  // Handwritten anchors first in each bucket
  for (const line of HANDWRITTEN_ORIGINALS.pickup) addUnique(buckets, 'pickup', line);
  for (const line of HANDWRITTEN_ORIGINALS.fun) addUnique(buckets, 'fun', line);
  for (const line of HANDWRITTEN_ORIGINALS.tech) addUnique(buckets, 'tech', line);
  for (const line of HANDWRITTEN_ORIGINALS.savage) addUnique(buckets, 'savage', line);
  for (const line of HANDWRITTEN_ORIGINALS.wisdom) addUnique(buckets, 'wisdom', line);

  // P1: Even better than X — Y (26 * 28 = 728)
  const p1Emojis = ['😘', '✨', '💫', '💕', '😍', '🔥'];
  NICE_THINGS.forEach((thing, i) => {
    SWEET_COMPLIMENTS.forEach((comp, j) => {
      const emoji = p1Emojis[(i + j) % p1Emojis.length];
      addUnique(buckets, 'pickup', `${emoji} Even better than ${thing} — ${comp}.`);
    });
  });

  // P2: Lead — Hook (25 * 35 = 875)
  const p2Emojis = ['😉', '💌', '😏', '💘', '🌟'];
  FLIRT_LEADS.forEach((lead, i) => {
    FLIRT_HOOKS.forEach((hook, j) => {
      const emoji = p2Emojis[(i * 3 + j) % p2Emojis.length];
      addUnique(buckets, 'pickup', `${emoji} ${lead}: ${hook}.`);
    });
  });

  // P3: CharmSubject + Reaction (25 * 25 = 625)
  const p3Emojis = ['✨', '❤️', '🍯', '🥰', '⚡'];
  CHARM_SUBJECTS.forEach((subj, i) => {
    CHARM_REACTIONS.forEach((react, j) => {
      const emoji = p3Emojis[(i + j * 2) % p3Emojis.length];
      addUnique(buckets, 'pickup', `${emoji} ${subj} ${react}.`);
    });
  });

  // P4: If condition, offer (25 * 25 = 625)
  const p4Emojis = ['🌷', '🎯', '💞', '🚀', '💬'];
  PLAYFUL_CONDITIONS.forEach((cond, i) => {
    PLAYFUL_OFFERS.forEach((offer, j) => {
      const emoji = p4Emojis[(i + j) % p4Emojis.length];
      addUnique(buckets, 'pickup', `${emoji} If ${cond}, I'd ${offer}.`);
    });
  });

  // F1: Currently X instead of Y (30 * 25 = 750)
  const f1Emojis = ['😂', '🙃', '😅', '🍕', '🛋️'];
  FUN_ACTIVITIES.forEach((act, i) => {
    ADULT_DUTIES.forEach((duty, j) => {
      const emoji = f1Emojis[(i + j) % f1Emojis.length];
      addUnique(buckets, 'fun', `${emoji} Currently ${act} instead of ${duty}.`);
    });
  });

  // F2: Status tag + funny clause (25 * 32 = 800)
  const f2Emojis = ['🤣', '☕', '⚡', '🎧', '🧃'];
  FUN_STATUS_TAGS.forEach((tag, i) => {
    FUNNY_CLAUSES.forEach((clause, j) => {
      const emoji = f2Emojis[(i + j * 2) % f2Emojis.length];
      addUnique(buckets, 'fun', `${emoji} ${tag} ${clause}.`);
    });
  });

  // F3: DayRole by day, NightRole by night (25 * 25 = 625)
  const f3Emojis = ['🌗', '😎', '🦉', '🎭', '🍿'];
  DAY_ROLES.forEach((day, i) => {
    NIGHT_ROLES.forEach((night, j) => {
      const emoji = f3Emojis[(i + j) % f3Emojis.length];
      addUnique(buckets, 'fun', `${emoji} ${day} by day, ${night} by night.`);
    });
  });

  // F4: Certified + quirky habit & trait (25 * 25 = 625)
  const f4Emojis = ['⚠️', '😜', '🤪', '📢', '🍟'];
  QUIRKY_HABITS.forEach((habit, i) => {
    QUIRKY_TRAITS.forEach((trait, j) => {
      const emoji = f4Emojis[(i + j) % f4Emojis.length];
      addUnique(buckets, 'fun', `${emoji} Note: ${habit} & ${trait}.`);
    });
  });

  // S1: Too busy to ignore noise (30 * 25 = 750)
  const s1Emojis = ['👑', '🦁', '🛡️', '🔥', '⚡'];
  BUSY_FOCUSES.forEach((focus, i) => {
    IGNORE_NOISES.forEach((noise, j) => {
      const emoji = s1Emojis[(i + j) % s1Emojis.length];
      addUnique(buckets, 'savage', `${emoji} Too ${focus} to ${noise}.`);
    });
  });

  // S2: Savage lead — end (20 * 25 = 500)
  const s2Emojis = ['🧊', '💎', '🚪', '⚖️', '🦅'];
  SAVAGE_LEADS.forEach((lead, i) => {
    SAVAGE_ENDS.forEach((end, j) => {
      const emoji = s2Emojis[(i + j) % s2Emojis.length];
      addUnique(buckets, 'savage', `${emoji} ${lead}: ${end}.`);
    });
  });

  // T1: Tech action — outcome (25 * 25 = 625)
  const t1Emojis = ['💻', '⚙️', '🚀', '🛰️', '🔌'];
  TECH_ACTIONS.forEach((act, i) => {
    TECH_OUTCOMES.forEach((out, j) => {
      const emoji = t1Emojis[(i + j) % t1Emojis.length];
      addUnique(buckets, 'tech', `${emoji} ${act} — ${out}.`);
    });
  });

  // T2: Telemetry with dynamic placeholders (25 * 20 = 500)
  const t2Emojis = ['📡', '🕷️', '🟢', '⚡', '🤖'];
  TELEMETRY_LABELS.forEach((label, i) => {
    TELEMETRY_NOTES.forEach((note, j) => {
      const emoji = t2Emojis[(i + j) % t2Emojis.length];
      addUnique(buckets, 'telemetry', `${emoji} {bot} ${label} • ${note}`);
    });
  });

  // W1: Wisdom lead: body (20 * 30 = 600)
  const w1Emojis = ['📖', '🌱', '🧭', '🕯️', '🕊️'];
  WISDOM_LEADS.forEach((lead, i) => {
    WISDOM_BODIES.forEach((body, j) => {
      const emoji = w1Emojis[(i + j) % w1Emojis.length];
      addUnique(buckets, 'wisdom', `${emoji} ${lead}: ${body}.`);
    });
  });

  // W2: Choose X over Y (25 * 25 = 625)
  const w2Emojis = ['⚖️', '🌟', '🔑', '🪴', '☀️'];
  GOOD_CHOICES.forEach((good, i) => {
    BAD_CHOICES.forEach((bad, j) => {
      const emoji = w2Emojis[(i + j) % w2Emojis.length];
      addUnique(buckets, 'wisdom', `${emoji} Choose ${good} over ${bad}.`);
    });
  });

  // V1: Chill TimeWindow — Scene (25 * 25 = 625)
  const v1Emojis = ['🌙', '🎧', '☁️', '🍵', '🌌'];
  TIME_WINDOWS.forEach((win, i) => {
    CHILL_SCENES.forEach((scene, j) => {
      const emoji = v1Emojis[(i + j) % v1Emojis.length];
      addUnique(buckets, 'vibes', `${emoji} ${win} — ${scene}.`);
    });
  });

  // H1: Hustle Action today so Reward (25 * 25 = 625)
  const h1Emojis = ['📈', '🏆', '🛠️', '⏳', '💼'];
  HUSTLE_ACTIONS.forEach((act, i) => {
    HUSTLE_REWARDS.forEach((rew, j) => {
      const emoji = h1Emojis[(i + j) % h1Emojis.length];
      addUnique(buckets, 'hustle', `${emoji} ${act} today so ${rew}.`);
    });
  });

  // C1: Social Conversation Starters (25 * 24 = 600)
  const c1Emojis = ['💬', '📲', '🗣️', '👋', '🎙️'];
  CHAT_TOPICS.forEach((tA, i) => {
    CHAT_TOPICS.forEach((tB, j) => {
      if (i === j) return;
      const emoji = c1Emojis[(i + j) % c1Emojis.length];
      addUnique(buckets, 'social', `${emoji} Text me about ${tA} or ${tB}.`);
    });
  });

  // R1: Wholesome Wishes (25 * 24 = 600)
  const r1Emojis = ['🌻', '🤍', '🌈', '🍀', '☀️'];
  WARM_GIFTS.forEach((gA, i) => {
    WARM_GIFTS.forEach((gB, j) => {
      if (i === j) return;
      const emoji = r1Emojis[(i + j) % r1Emojis.length];
      addUnique(buckets, 'warm', `${emoji} Wishing you ${gA} and ${gB}.`);
    });
  });

  // Deterministically reorder each bucket using a coprime stride so template families
  // within each category are also thoroughly mixed, then deduplicate globally.
  const globalSeen = new Set(seenCore);
  const shuffledBuckets = {};
  for (const [cat, items] of Object.entries(buckets)) {
    const n = items.length;
    if (n === 0) {
      shuffledBuckets[cat] = [];
      continue;
    }
    // Find a stride coprime to n near n * 0.618 (golden ratio mixing)
    let stride = Math.max(1, Math.floor(n * 0.6180339887));
    const gcd = (a, b) => (b === 0 ? a : gcd(b, a % b));
    while (gcd(stride, n) !== 1) stride += 1;

    const deduped = [];
    for (let k = 0; k < n; k += 1) {
      const item = items[(k * stride) % n];
      const normKey = item.toLowerCase();
      if (!globalSeen.has(item) && !globalSeen.has(normKey)) {
        globalSeen.add(item);
        globalSeen.add(normKey);
        deduped.push(item);
      }
    }
    shuffledBuckets[cat] = deduped;
  }

  // Round-robin interleave across all categories (mixed pickup, fun, vibes, savage, wisdom, tech, etc.)
  const categoryOrder = [
    'pickup',
    'fun',
    'vibes',
    'savage',
    'telemetry',
    'wisdom',
    'tech',
    'social',
    'hustle',
    'warm',
  ];
  const cursors = Object.fromEntries(categoryOrder.map((c) => [c, 0]));
  const remainingCore = CORE_AUTOBIOS.slice(1);
  let coreCursor = 0;

  const extraMixed = [];
  let round = 0;
  while (extraMixed.length < EXTRA_BIO_TARGET) {
    let addedInRound = false;
    for (const cat of categoryOrder) {
      if (extraMixed.length >= EXTRA_BIO_TARGET) break;
      const arr = shuffledBuckets[cat];
      if (cursors[cat] < arr.length) {
        extraMixed.push(arr[cursors[cat]]);
        cursors[cat] += 1;
        addedInRound = true;
      }
    }
    round += 1;
    if (!addedInRound || round > 50_000) break;
  }

  // Interleave the remaining 99 core bios cleanly throughout the mixed rotation
  // while keeping CORE_AUTOBIOS[0] at index 0 for predictable initial bot status.
  const combined = [CORE_AUTOBIOS[0]];
  const step = Math.floor(extraMixed.length / (remainingCore.length + 1));
  for (let i = 0; i < extraMixed.length; i += 1) {
    combined.push(extraMixed[i]);
    if (coreCursor < remainingCore.length && (i + 1) % step === 0) {
      combined.push(remainingCore[coreCursor]);
      coreCursor += 1;
    }
  }
  while (coreCursor < remainingCore.length) {
    combined.push(remainingCore[coreCursor]);
    coreCursor += 1;
  }

  return Object.freeze(combined);
}

let cachedAllBios = null;

export function getBuiltinAutobios() {
  if (!cachedAllBios) {
    cachedAllBios = buildGeneratedCatalog();
  }
  return cachedAllBios;
}
