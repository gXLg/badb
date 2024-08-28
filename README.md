# badb
Simple database with caching

* Successfull successor of [<kbd>gxlg-asyncdb</kbd>](https://github.com/gXLg/gxlg-asyncdb)
* Uses LRU cache to reduce read/write operations
* Doesn't keep the whole database in memory
* Index overloading for nice requests
* Features `BadTable` and `BadSet` classes
* Internal control over file system and data locks, allowing safe asynchronous usage
* Word-play on "Bad DB", but the database in itself is actually pretty solid (or is it?)

# Examples

Simple database for a banking system
```js
(async () => {

  const { BadTable } = require("badb");

  const money = new BadTable("./money.badb", {
    "key": "userId",
    "values": [
      { "name": "userId", "maxLength": 10 },
      { "name": "money", "type": "int32", "default": 0 }
    ]
  });

  await money["bank"](e => { e.money = 10_000_000; });

  async function addMoney(userId, amount) {
    await money[userId](entry => {
      entry.money += amount;
    });
  }

  async function withdrawMoney(userId, amount) {
    await money[userId](entry => {
      entry.money -= amount;
    });
  }

  async function deleteAccount(userId) {
    const amount = await money[userId]((entry, control) => {
      control.remove();
      return entry.money;
    });
    await money["bank"](entry => { entry.money += amount; });
  }

})();
```

Simple asynchronous set implementation
```js
(async () => {

  const { BadSet } = require("badb");

  const set = new BadSet("./set.badb", { "type": "uint16" });

  await set.add(69);
  await set.remove(420);
  if (await set.has(1337)) {
    console.log(set.size());
  }

})();
```
