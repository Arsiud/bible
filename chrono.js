"use strict";

// The chronological Bible: every verse once, in the order of the events it tells about (not the order
// the books were written or are printed). Passages are split at verses where parallel accounts interleave:
// Samuel, Kings and Chronicles reign by reign, the four Gospels woven into one story, Paul's letters at
// the point in Acts where he wrote them. Psalms sit beside the stories their titles name (Psalm 51 after
// Bathsheba). Dates of Job, Joel and Obadiah are debated; they sit at their traditional places.
// Format: "Book ranges; Book ranges", a range being 5, 5-7, 5:3, 5:3-9 or 5:3-6:2 (KJV verse numbers).
// The whole-chapter version of this order is kept on the git branch chrono-by-chapter.
const CHRONO_ABBREVIATIONS = ("Gen Exod Lev Num Deut Josh Judg Ruth 1Sam 2Sam 1Kgs 2Kgs 1Chr 2Chr Ezra Neh Esth Job Ps Prov " +
  "Eccl Song Isa Jer Lam Ezek Dan Hos Joel Amos Obad Jonah Mic Nah Hab Zeph Hag Zech Mal Matt Mark Luke John Acts Rom " +
  "1Cor 2Cor Gal Eph Phil Col 1Thess 2Thess 1Tim 2Tim Titus Phlm Heb Jas 1Pet 2Pet 1John 2John 3John Jude Rev").split(" ");

const CHRONO_ERAS = [
  ["Creation and the flood", "Gen 1-11; 1Chr 1:1-27"],
  ["Job", "Job 1-42"],
  ["Abraham, Isaac, Jacob and Joseph", "Gen 12-36; 1Chr 1:28-54; Gen 37-50"],
  ["Moses and the law", "Exod 1-40; Lev 1-27; Num 1-36; Deut 1-34; Ps 90"],
  ["Joshua and the judges", "Josh 1-24; Judg 1-2, 17-21, 3-16; Ruth 1-4; 1Chr 2-8"],
  ["Samuel and Saul", "1Sam 1-18; 1Sam 19:1-17; Ps 59; 1Sam 19:18-24; 1Sam 20-21; Ps 56, 34; 1Sam 22:1-5; Ps 142, 57; " +
    "1Chr 12:8-18; 1Sam 22:6-23; Ps 52; 1Sam 23:1-24; Ps 54; 1Sam 23:25-29; Ps 63; 1Sam 24-27; 1Chr 12:1-7; 1Sam 28-29; " +
    "1Chr 12:19-22; 1Sam 30-31; 1Chr 9:35-44; 1Chr 10"],
  ["King David", "2Sam 1-4; 2Sam 5:1-5; 1Chr 11:1-3; 1Chr 12:23-40; 2Sam 5:6-10; 1Chr 11:4-9; 2Sam 5:11-25; 1Chr 14; " +
    "2Sam 6:1-11; 1Chr 13; 1Chr 15:1-24; 2Sam 6:12-19; 1Chr 15:25-29; 1Chr 16; Ps 105, 96, 106; 2Sam 6:20-23; Ps 24; " +
    "2Sam 7; 1Chr 17; 2Sam 8; 1Chr 18; Ps 60, 108; 2Sam 9-10; 1Chr 19; 2Sam 11; 2Sam 12:1-25; Ps 51, 32; 2Sam 12:26-31; " +
    "1Chr 20:1-3; 2Sam 13-15; Ps 3, 4; 2Sam 16; Ps 7; 2Sam 17-21; 1Chr 20:4-8; 2Sam 22; Ps 18; 2Sam 23; 1Chr 11:10-47; " +
    "2Sam 24; 1Chr 21-22; Ps 30"],
  ["Songs of David", "Ps 1-2, 5-6, 8-17, 19-23, 25-29, 31, 33, 35-41, 53, 55, 58, 61-62, 64-71, 86, 91-95, 97-101, 103-104, " +
    "109-110, 122, 124, 131, 133, 138-141, 143-145"],
  ["Songs of the temple singers", "Ps 42-45, 47, 49-50, 73, 75, 77-78, 81-84, 87-88"],
  ["Solomon", "1Kgs 1; 1Chr 23-28; 1Chr 29:1-25; 1Kgs 2:1-12; 1Chr 29:26-30; 1Kgs 2:13-46; 1Kgs 3:1-15; 2Chr 1:1-13; " +
    "1Kgs 3:16-28; 1Kgs 4; Ps 72; Prov 1-24; Song 1-8; 1Kgs 5; 2Chr 2; 1Kgs 6; 2Chr 3:1-14; 1Kgs 7; 2Chr 3:15-17; 2Chr 4; " +
    "2Chr 5:1; 1Kgs 8:1-11; 2Chr 5:2-14; 1Kgs 8:12-53; 2Chr 6; Ps 132; 1Kgs 8:54-66; 2Chr 7:1-10; Ps 127; 1Kgs 9:1-9; " +
    "2Chr 7:11-22; 1Kgs 9:10-28; 2Chr 8; 1Kgs 10:1-13; 2Chr 9:1-12; 1Kgs 10:14-29; 2Chr 1:14-17; 2Chr 9:13-28; " +
    "1Kgs 11:1-40; Eccl 1-12; 1Kgs 11:41-43; 2Chr 9:29-31"],
  ["The kingdom divides", "1Kgs 12:1-19; 2Chr 10; 1Kgs 12:20-24; 2Chr 11:1-4; 1Kgs 12:25-33; 2Chr 11:5-23; 1Kgs 13-14; " +
    "2Chr 12; 1Kgs 15:1-8; 2Chr 13; 1Kgs 15:9-24; 2Chr 14-16; 1Kgs 15:25-16:34"],
  ["Elijah and Jehoshaphat", "2Chr 17; 1Kgs 17-21; 1Kgs 22:1-40; 2Chr 18-19; 2Chr 20:1-30; 1Kgs 22:41-50; 2Chr 20:31-37; " +
    "2Chr 21:1; 1Kgs 22:51-53; 2Kgs 1"],
  ["Elisha", "2Kgs 2:1-8:24; 2Chr 21:2-20; Obad 1; 2Kgs 8:25-29; 2Chr 22:1-6; 2Kgs 9-10; 2Chr 22:7-9; 2Kgs 11; " +
    "2Chr 22:10-12; 2Chr 23; 2Kgs 12; 2Chr 24; Joel 1-3; 2Kgs 13"],
  ["Jonah, Amos, Hosea and Isaiah", "2Kgs 14:1-22; 2Chr 25; 2Kgs 14:23-29; Jonah 1-4; Amos 1-9; 2Kgs 15:1-7; 2Chr 26; " +
    "Hos 1-14; Isa 1-6; 2Kgs 15:8-38; 2Chr 27; 2Kgs 16; 2Chr 28; Isa 7-12; Mic 1-7"],
  ["Israel falls; Hezekiah", "2Kgs 17; Ps 80; 2Kgs 18:1-12; 2Chr 29-31; Prov 25-31; Isa 13-35; 2Kgs 18:13-37; Isa 36; " +
    "2Chr 32:1-19; 2Kgs 19; Isa 37; 2Chr 32:20-23; Ps 46, 48, 76; 2Kgs 20:1-11; Isa 38; 2Kgs 20:12-19; Isa 39; " +
    "2Chr 32:24-33; 2Kgs 20:20-21; Isa 40-66"],
  ["Judah's last kings: Jeremiah", "2Kgs 21:1-18; 2Chr 33:1-20; 2Kgs 21:19-26; 2Chr 33:21-25; Nah 1-3; 2Kgs 22:1-2; " +
    "2Chr 34:1-7; Zeph 1-3; Jer 1-12; 2Kgs 22:3-20; 2Chr 34:8-33; 2Kgs 23:1-30; 2Chr 35; 2Kgs 23:31-34; 2Chr 36:1-4; " +
    "2Kgs 23:35-24:7; 2Chr 36:5-8; Hab 1-3; Jer 26, 13-20, 22-23, 25, 35-36, 45-49; Dan 1-2; 2Kgs 24:8-17; 2Chr 36:9-10; " +
    "Jer 24; 2Kgs 24:18-20; 2Chr 36:11-16; Jer 27-29; Ezek 1-24; Jer 30-31, 34, 21, 37, 32-33, 38"],
  ["Jerusalem falls; exile in Babylon", "Jer 39; 2Kgs 25:1-21; 2Chr 36:17-21; Jer 52:1-30; Lam 1-5; Ps 74, 79, 137; " +
    "2Kgs 25:22-26; Jer 40-44; Ezek 25-33; Jer 50-51; Ezek 34-48; Dan 3-4; 2Kgs 25:27-30; Jer 52:31-34; Dan 7-8; " +
    "Ps 89, 102; Dan 5-6, 9"],
  ["Return and rebuilding", "2Chr 36:22-23; Ezra 1-3; Dan 10-12; Ezra 4:1-5, 4:24; Ezra 5:1-2; Hag 1-2; Zech 1-8; " +
    "Ezra 5:3-17; Ezra 6; Ps 85, 107, 111-121, 123, 125-126, 128-130, 134-136, 146-150; Zech 9-14; Esth 1-10; Ezra 7-10; " +
    "Ezra 4:6-23; Neh 1-10; Neh 11; 1Chr 9:1-34; Neh 12-13; Mal 1-4"],
  ["Jesus: birth and first days", "Luke 1:1-4; John 1:1-18; Matt 1:1-17; Luke 3:23-38; Luke 1:5-80; Matt 1:18-25; " +
    "Luke 2:1-38; Matt 2; Luke 2:39-52; Matt 3:1-12; Mark 1:1-8; Luke 3:1-18; Matt 3:13-17; Mark 1:9-11; Luke 3:21-22; " +
    "Matt 4:1-11; Mark 1:12-13; Luke 4:1-13; John 1:19-51; John 2-3; Luke 3:19-20; John 4:1-45; Matt 4:12-17; " +
    "Mark 1:14-15; Luke 4:14-15; John 4:46-54; Luke 4:16-30"],
  ["Jesus in Galilee", "Matt 4:18-22; Mark 1:16-20; Luke 5:1-11; Mark 1:21-28; Luke 4:31-37; Matt 8:14-17; Mark 1:29-34; " +
    "Luke 4:38-41; Mark 1:35-39; Luke 4:42-44; Matt 4:23-25; Matt 8:1-4; Mark 1:40-45; Luke 5:12-16; Matt 9:1-8; " +
    "Mark 2:1-12; Luke 5:17-26; Matt 9:9-17; Mark 2:13-22; Luke 5:27-39; John 5; Matt 12:1-8; Mark 2:23-28; Luke 6:1-5; " +
    "Matt 12:9-14; Mark 3:1-6; Luke 6:6-11; Matt 12:15-21; Mark 3:7-12; Mark 3:13-19; Luke 6:12-16; Matt 5-7; " +
    "Luke 6:17-49; Matt 8:5-13; Luke 7:1-10; Luke 7:11-17; Matt 11:2-19; Luke 7:18-35; Matt 11:20-30; Luke 7:36-50; " +
    "Luke 8:1-3; Mark 3:20-30; Matt 12:22-45; Matt 12:46-50; Mark 3:31-35; Luke 8:19-21; Matt 13:1-53; Mark 4:1-34; " +
    "Luke 8:4-18; Matt 8:18-27; Mark 4:35-41; Luke 8:22-25; Matt 8:28-34; Mark 5:1-20; Luke 8:26-39; Matt 9:18-26; " +
    "Mark 5:21-43; Luke 8:40-56; Matt 9:27-34; Matt 13:54-58; Mark 6:1-6; Matt 9:35-38; Matt 10; Matt 11:1; " +
    "Mark 6:7-13; Luke 9:1-6; Matt 14:1-12; Mark 6:14-29; Luke 9:7-9; Matt 14:13-21; Mark 6:30-44; Luke 9:10-17; " +
    "John 6:1-15; Matt 14:22-33; Mark 6:45-52; John 6:16-21; Matt 14:34-36; Mark 6:53-56; John 6:22-71; Matt 15:1-20; " +
    "Mark 7:1-23; John 7:1; Matt 15:21-28; Mark 7:24-30; Matt 15:29-31; Mark 7:31-37; Matt 15:32-39; Mark 8:1-10; " +
    "Matt 16:1-4; Mark 8:11-13; Matt 16:5-12; Mark 8:14-21; Mark 8:22-26; Matt 16:13-20; Mark 8:27-30; Luke 9:18-21; " +
    "Matt 16:21-28; Mark 8:31-9:1; Luke 9:22-27; Matt 17:1-13; Mark 9:2-13; Luke 9:28-36; Matt 17:14-21; Mark 9:14-29; " +
    "Luke 9:37-43; Matt 17:22-23; Mark 9:30-32; Luke 9:44-45; Matt 17:24-27; Matt 18:1-5; Mark 9:33-37; Luke 9:46-48; " +
    "Mark 9:38-41; Luke 9:49-50; Matt 18:6-14; Mark 9:42-50; Matt 18:15-35"],
  ["Jesus on the way to Jerusalem", "John 7:2-10; Luke 9:51-62; John 7:11-8:59; Luke 10-11; Luke 12:1-13:21; John 9-10; " +
    "Luke 13:22-17:10; John 11:1-54; Luke 17:11-18:14; Matt 19:1-2; Mark 10:1; Matt 19:3-12; Mark 10:2-12; " +
    "Matt 19:13-15; Mark 10:13-16; Luke 18:15-17; Matt 19:16-30; Mark 10:17-31; Luke 18:18-30; Matt 20:1-16; " +
    "Matt 20:17-19; Mark 10:32-34; Luke 18:31-34; Matt 20:20-28; Mark 10:35-45; Matt 20:29-34; Mark 10:46-52; " +
    "Luke 18:35-43; Luke 19:1-27"],
  ["Jesus' last week", "John 11:55-12:11; Matt 26:6-13; Mark 14:3-9; Matt 21:1-11; Mark 11:1-11; Luke 19:28-44; " +
    "John 12:12-19; Matt 21:12-17; Mark 11:12-19; Luke 19:45-48; Matt 21:18-22; Mark 11:20-26; John 12:20-50; " +
    "Matt 21:23-27; Mark 11:27-33; Luke 20:1-8; Matt 21:28-22:14; Mark 12:1-12; Luke 20:9-19; Matt 22:15-22; " +
    "Mark 12:13-17; Luke 20:20-26; Matt 22:23-33; Mark 12:18-27; Luke 20:27-40; Matt 22:34-40; Mark 12:28-34; " +
    "Matt 22:41-46; Mark 12:35-37; Luke 20:41-44; Matt 23; Mark 12:38-40; Luke 20:45-47; Mark 12:41-44; Luke 21:1-4; " +
    "Matt 24-25; Mark 13; Luke 21:5-38; Matt 26:1-5; Mark 14:1-2; Luke 22:1-2; Matt 26:14-16; Mark 14:10-11; " +
    "Luke 22:3-6; Matt 26:17-19; Mark 14:12-16; Luke 22:7-13; Matt 26:20-25; Mark 14:17-21; Luke 22:14-30; " +
    "John 13:1-30; Matt 26:26-29; Mark 14:22-25; John 13:31-38; Luke 22:31-38; Matt 26:30-35; Mark 14:26-31; " +
    "John 14-17; Matt 26:36-46; Mark 14:32-42; Luke 22:39-46; John 18:1"],
  ["The cross and the empty tomb", "Matt 26:47-56; Mark 14:43-52; Luke 22:47-53; John 18:2-12; John 18:13-27; " +
    "Matt 26:57-75; Mark 14:53-72; Luke 22:54-71; Matt 27:1-10; Mark 15:1-15; Matt 27:11-26; Luke 23:1-25; " +
    "John 18:28-19:16; Matt 27:27-31; Mark 15:16-20; Matt 27:32-56; Mark 15:21-41; Luke 23:26-49; John 19:17-37; " +
    "Matt 27:57-66; Mark 15:42-47; Luke 23:50-56; John 19:38-42; Matt 28:1-15; Mark 16:1-11; Luke 24:1-12; " +
    "John 20:1-18; Mark 16:12-13; Luke 24:13-35; Mark 16:14; Luke 24:36-43; John 20:19-31; John 21; Matt 28:16-20; " +
    "Mark 16:15-20; Luke 24:44-53"],
  ["The church begins", "Acts 1-12; Jas 1-5"],
  ["Paul's journeys", "Acts 13-14; Gal 1-6; Acts 15-17; Acts 18:1-11; 1Thess 1-5; 2Thess 1-3; Acts 18:12-19:22; " +
    "1Cor 1-16; Acts 19:23-20:2; 2Cor 1-13; Acts 20:3; Rom 1-16; Acts 20:4-38"],
  ["Paul in chains; the last letters", "Acts 21-28; Eph 1-6; Col 1-4; Phlm 1; Phil 1-4; 1Tim 1-6; Titus 1-3; 1Pet 1-5; " +
    "Heb 1-13; 2Tim 1-4; 2Pet 1-3; Jude 1"],
  ["John's last writings", "1John 1-5; 2John 1; 3John 1; Rev 1-22"],
];
