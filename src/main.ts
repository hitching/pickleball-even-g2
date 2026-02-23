import { waitForEvenAppBridge } from '@evenrealities/even_hub_sdk'
import './styles.css'

async function main() {
  const bridge = await waitForEvenAppBridge()
  console.log('Bridge ready:', bridge)
}

main()
