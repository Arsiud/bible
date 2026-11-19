"use strict";

// The chronological Bible: every chapter once, in the order of the events it tells about (not the order
// the books were written or are printed). Chapters stay whole so places, bookmarks, notes and audio
// work the same in both orders. Psalms are set beside the stories their titles name (Psalm 51 after
// Bathsheba); the rest are grouped where they most likely belong. Dates of Job, Joel and Obadiah are
// debated; they sit at their traditional places.
const CHRONO_ABBREVIATIONS = ("Gen Exod Lev Num Deut Josh Judg Ruth 1Sam 2Sam 1Kgs 2Kgs 1Chr 2Chr Ezra Neh Esth Job Ps Prov " +
  "Eccl Song Isa Jer Lam Ezek Dan Hos Joel Amos Obad Jonah Mic Nah Hab Zeph Hag Zech Mal Matt Mark Luke John Acts Rom " +
  "1Cor 2Cor Gal Eph Phil Col 1Thess 2Thess 1Tim 2Tim Titus Phlm Heb Jas 1Pet 2Pet 1John 2John 3John Jude Rev").split(" ");

const CHRONO_ERAS = [
  ["Creation and the flood", "Gen 1-11"],
  ["Job", "Job 1-42"],
  ["Abraham, Isaac, Jacob and Joseph", "Gen 12-50"],
  ["Moses and the law", "Exod 1-40; Lev 1-27; Num 1-36; Deut 1-34; Ps 90"],
  ["Joshua and the judges", "Josh 1-24; Judg 1-21; Ruth 1-4"],
  ["Samuel and Saul", "1Sam 1-19; Ps 59; 1Sam 20-21; Ps 56, 34; 1Sam 22; Ps 52, 142, 57; 1Sam 23; Ps 54, 63; " +
    "1Sam 24-31; 1Chr 1-10"],
  ["King David", "2Sam 1-5; 1Chr 11-12; 2Sam 6; 1Chr 13-16; Ps 24, 96, 105, 106; 2Sam 7; 1Chr 17; 2Sam 8-9; 1Chr 18; " +
    "Ps 60, 108; 2Sam 10; 1Chr 19; 2Sam 11-12; 1Chr 20; Ps 51, 32; 2Sam 13-15; Ps 3, 4; 2Sam 16-18; Ps 7; " +
    "2Sam 19-22; Ps 18; 2Sam 23-24; 1Chr 21-22; Ps 30"],
  ["Songs of David", "Ps 1-2, 5-6, 8-17, 19-23, 25-29, 31, 33, 35-41, 53, 55, 58, 61-62, 64-71, 86, 91-95, 97-101, 103-104, " +
    "109-110, 122, 124, 131, 133, 138-141, 143-145"],
  ["Songs of the temple singers", "Ps 42-45, 47, 49-50, 73, 75, 77-78, 81-84, 87-88"],
  ["Solomon", "1Kgs 1; 1Chr 23-29; 1Kgs 2; 2Chr 1; 1Kgs 3-4; Ps 72; Prov 1-24; Song 1-8; 1Kgs 5-6; 2Chr 2-3; 1Kgs 7; " +
    "2Chr 4; 1Kgs 8; 2Chr 5-7; Ps 132, 127; 1Kgs 9; 2Chr 8; 1Kgs 10; 2Chr 9; 1Kgs 11; Eccl 1-12"],
  ["The kingdom divides: Elijah and Elisha", "1Kgs 12; 2Chr 10-11; 1Kgs 13-14; 2Chr 12; 1Kgs 15; 2Chr 13-16; 1Kgs 16; " +
    "2Chr 17; 1Kgs 17-22; 2Chr 18-20; 2Kgs 1-8; 2Chr 21; Obad 1; 2Kgs 9-11; 2Chr 22-23; Joel 1-3; 2Kgs 12; 2Chr 24; 2Kgs 13"],
  ["Jonah, Amos, Hosea and Isaiah", "2Kgs 14; 2Chr 25; Jonah 1-4; Amos 1-9; Hos 1-14; 2Kgs 15; 2Chr 26-27; Isa 1-6; " +
    "2Kgs 16; 2Chr 28; Isa 7-12; Mic 1-7"],
  ["Israel falls; Hezekiah", "2Kgs 17; Ps 80; 2Kgs 18; 2Chr 29-31; Prov 25-31; Isa 13-35; 2Kgs 19; 2Chr 32; Isa 36-39; " +
    "Ps 46, 48, 76; 2Kgs 20; Isa 40-66"],
  ["Judah's last kings: Jeremiah", "2Kgs 21; 2Chr 33; Nah 1-3; Zeph 1-3; Jer 1-12; 2Kgs 22-23; 2Chr 34-35; Hab 1-3; " +
    "2Kgs 24; Jer 26, 13-20, 22-23, 25, 35-36, 45-49; Dan 1-2; Jer 24, 27-29; Ezek 1-24; Jer 30-31, 34, 21, 37, 32-33, 38-39"],
  ["Jerusalem falls; exile in Babylon", "2Kgs 25; 2Chr 36; Jer 52; Lam 1-5; Ps 74, 79, 137; Jer 40-44; Ezek 25-33; " +
    "Jer 50-51; Ezek 34-48; Dan 3-4, 7-8; Ps 89, 102; Dan 5-6, 9"],
  ["Return and rebuilding", "Ezra 1-3; Dan 10-12; Ezra 4; Hag 1-2; Zech 1-14; Ezra 5-6; Ps 85, 107, 111-121, 123, 125-126, " +
    "128-130, 134-136, 146-150; Esth 1-10; Ezra 7-10; Neh 1-13; Mal 1-4"],
  ["Jesus: birth and first days", "Luke 1; Matt 1; Luke 2; Matt 2-3; Mark 1; Luke 3; Matt 4; Luke 4; John 1-4"],
  ["Jesus in Galilee", "Luke 5; John 5; Mark 2; Matt 5-7; Luke 6; Matt 8; Luke 7; Mark 3; Matt 9-12; Mark 4; Matt 13; " +
    "Luke 8; Mark 5-6; Matt 14; Luke 9; John 6; Matt 15; Mark 7; Matt 16; Mark 8; Matt 17; Mark 9; Matt 18"],
  ["Jesus on the way to Jerusalem", "John 7-10; Luke 10-17; John 11; Luke 18; Matt 19; Mark 10; Matt 20; Luke 19"],
  ["Jesus' last week", "John 12; Matt 21; Mark 11; Matt 22; Mark 12; Luke 20; Matt 23-25; Mark 13; Luke 21; Matt 26; " +
    "Mark 14; Luke 22; John 13-18"],
  ["The cross and the empty tomb", "Matt 27; Mark 15; Luke 23; John 19; Matt 28; Mark 16; Luke 24; John 20-21"],
  ["The church begins", "Acts 1-12; Jas 1-5"],
  ["Paul's journeys", "Acts 13-14; Gal 1-6; Acts 15-17; 1Thess 1-5; 2Thess 1-3; Acts 18-19; 1Cor 1-16; 2Cor 1-13; " +
    "Acts 20; Rom 1-16"],
  ["Paul in chains; the last letters", "Acts 21-28; Eph 1-6; Phil 1-4; Col 1-4; Phlm 1; 1Tim 1-6; Titus 1-3; 1Pet 1-5; " +
    "Heb 1-13; 2Tim 1-4; 2Pet 1-3; Jude 1"],
  ["John's last writings", "1John 1-5; 2John 1; 3John 1; Rev 1-22"],
];
