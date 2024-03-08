const TrinityMathTester = artifacts.require("TrinityMathTester")

contract('TrinityMath', async accounts => {
  let mathTester
  beforeEach('deploy tester', async () => {
    mathTester = await TrinityMathTester.new()
  })

  const checkFunction = async (func, cond, params) => {
    assert.equal(await mathTester[func](...params), cond(...params))
  }

  it('max works if a > b', async () => {
    await checkFunction('callMax', (a, b) => Math.max(a, b), [2, 1])
  })

  it('max works if a = b', async () => {
    await checkFunction('callMax', (a, b) => Math.max(a, b), [2, 2])
  })

  it('max works if a < b', async () => {
    await checkFunction('callMax', (a, b) => Math.max(a, b), [1, 2])
  })
})

contract("Reset chain state", async accounts => { })
