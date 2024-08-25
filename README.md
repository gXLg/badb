# badb
Simple database with caching

* Successfull successor of [<kbd>gxlg-asyncdb</kbd>](https://github.com/gXLg/gxlg-asyncdb)
* Uses LRU cache to reduce read/write operations
* Doesn't keep the whole database in memory
* Index overloading for nice requests
* Features `BadTable` and `BadSet` classes
* Internal control over file system and data locks, allowing safe asynchronous usage
* Word-play on "Bad DB", but the database in itself is actually pretty solid (or is it?)
