const Tools=require('../../../sources/maclauncher/scripts/native-binary-tools.cjs');
module.exports={...Tools,formulaRoot(file){const match=file.match(/^(.*\/Cellar\/([^/]+)\/([^/]+))\//);return match?{root:match[1],name:match[2],version:match[3]}:null;}};
