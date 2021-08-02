<?php

/*
	Receive image data, save to file, post to magnolia image api
	Not in use as
		1) couldn't post files and
		2) could be solved in client-size JS
*/

header("Access-Control-Allow-Origin: *");
header('Access-Control-Allow-Headers: Content-Type');

error_reporting(-1); // ALL messages and 
ini_set('display_errors', 'On');
date_default_timezone_set('America/New_York');
//$agent = "Mozilla/5.0 (Windows; U; Windows NT 5.0; en-US; rv:1.4) Gecko/20030624 Netscape/7.1 (ax)";

// delete files
function delete($file_paths){
	foreach($file_paths as $file_path){
		if(!unlink($file_path)) json_response(1, "could not delete files");
	}
}

/*
 * Collect all Details from Angular HTTP Request.
 * http://codeforgeek.com/2014/07/angular-post-request-php/
 */ 
  $postdata = file_get_contents("php://input");
  $request = json_decode($postdata);
  @$type = $request->type;
  @$tool = $request->tool;
  @$caption = $request->caption;
  @$content = $request->content;
  @$sizes = $request->sizes;
  //echo $type; //this will go back under "data" of angular call.
/*
 * You can use $type and $tool for further work. Such as Database calls.
 */   

//read data from post
$format = '.png';
$filename = $tool.'_'.date('YmdGis').'_';//ready for size appended

//move into temporary directory for image set
chdir('tmp/'); //switch into tmp directory
//mkdir($filename, 0777, true); //make directory for this image set
//chdir($filename.'/');//switch into image set directory
$path = realpath(null);

//$filepath = '/var/www/html/users/squire/cardkit-v2/app/php/tmp/'.$filename.'/';
$filepath = 'http://local.wsj.com:8888/cardkit-v2/app/php/tmp/'.$filename.'/';
$files = array();

//save data to temp file
foreach($sizes as $index=>$size) {
	$fn = $filename.$size.$format;
	$file = fopen($fn, 'w');
	$contents = file_get_contents($content[$index]);
	fwrite($file, $contents);
	//save file name
	//$cfile = curl_file_create(realpath($fn), 'image/png', $fn);
	//$cfile = new CURLFile($filepath.$fn, 'image/png', $fn);
	//$files['files[]'] = $cfile;
	$files['files[]'] = '@'.realpath($fn);//.';filename='.$fn;
	//$files['files[]'] = '@'.$filepath.$fn;//.';filename='.$fn;
	//$files['filename'] = $fn;
	$filepaths[] = $fn;
}

$magnolia_data = array(
	'env' => 'QA',
//	'workflow' => 'online',
	'graphic_kind' => 'Chart',
	'product' => 'cardkit',
	'credit' => 'WSJ',
	'caption' => $caption
);

$send_data = array_merge($magnolia_data, $files);

echo 'request ';
print_r($send_data);

//send data to gams
//$url = 'http://graphicstools.dowjones.net/api/magnolia/online/images';
$url = 'http://local.wsj.com:8888/cardkit-v2/app/php/testMagnolia.php';
//$url = 'http://graphicsdev.dowjones.net/users/squire/cardkit/php/testMagnolia.php';
$header = array('Content-Type: multipart/form-data');

$ch = curl_init();
 
curl_setopt($ch, CURLOPT_URL, $url);
curl_setopt($ch, CURLOPT_HTTPHEADER, $header);
curl_setopt($ch, CURLOPT_POST, 1);
curl_setopt($ch, CURLOPT_POSTFIELDS, $magnolia_data);
curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
//curl_setopt($ch, CURLOPT_SAFE_UPLOAD, true);
//curl_setopt($ch, CURLINFO_HEADER_OUT, true);
//curl_setopt($ch, CURLOPT_VERBOSE, true);

$response = curl_exec($ch);
//$header_info = curl_getinfo($ch,CURLINFO_HEADER_OUT);
curl_close($ch);

//print_r($header_info);
echo 'response ';
print_r($response);

//delete($filepaths);

