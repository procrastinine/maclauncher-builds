import {main} from '../../build.mjs';
try{console.log(JSON.stringify(main(process.argv.slice(2),'arguments')));}catch(error){console.error(error.message);process.exitCode=1;}
